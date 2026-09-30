import type { MeetingAudioClockAnchor, MeetingRecordingEpochDto, MeetingTranscriptArtifact, ZoomSpeakerCalibration, ZoomSpeakerDecision, ZoomSpeakerObservation } from "../contracts/meetingRecording.js";
import { zoomSpeakerCalibrationSchema } from "../contracts/meetingRecording.js";

export interface ZoomMatcherInput {
  transcript: MeetingTranscriptArtifact;
  observations: ZoomSpeakerObservation[];
  anchors: MeetingAudioClockAnchor[];
  epochs: Array<Pick<MeetingRecordingEpochDto, "recordingId" | "source" | "epochIndex" | "startFrame" | "frameCount" | "state">>;
  partOffsets: Array<{ recordingId: string; startFrame: number; frameCount: number }>;
  calibration?: ZoomSpeakerCalibration;
  incompleteRecordingIds?: string[];
}

/** Run-local only. No provider labels or participant names are identities. */
export function matchZoomSpeakers(input: ZoomMatcherInput): ZoomSpeakerDecision[] {
  const calibration = input.calibration ? zoomSpeakerCalibrationSchema.parse(input.calibration) : null;
  const segments = (input.transcript.segments ?? []).filter((segment) => segment.speaker?.startsWith("system:") &&
    Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);
  const decisions = input.observations.map((observation): ZoomSpeakerDecision => {
    const base: ZoomSpeakerDecision = { speakerId: null, displayName: observation.displayName || null, status: "rejected", reason: "clock-coverage-gap", observationIds: [observation.id], clockAnchorIds: [], intervals: [], measurementId: calibration?.measurementId ?? null, calibration };
    if (observation.activity !== "explicit") return { ...base, reason: observation.reason ?? "activity-unconfirmed" };
    if (input.incompleteRecordingIds?.includes(observation.recordingId)) return { ...base, reason: "metadata-incomplete" };
    const part = input.partOffsets.find((item) => item.recordingId === observation.recordingId);
    const startNs = BigInt(observation.readStartHostNs);
    const endNs = BigInt(observation.readEndHostNs);
    const anchors = input.anchors.filter((anchor) => anchor.recordingId === observation.recordingId && anchor.clock.reason === null &&
      anchor.clock.hostStartNs !== null && anchor.clock.hostEndNs !== null &&
      BigInt(anchor.clock.hostStartNs) <= startNs && BigInt(anchor.clock.hostEndNs) >= endNs);
    // Never interpolate between independent anchors or across a restart/gap.
    if (!part || anchors.length !== 1) return base;
    const anchor = anchors[0];
    const clock = anchor.clock;
    const epoch = input.epochs.find((item) => item.recordingId === anchor.recordingId && item.source === "system" && item.epochIndex === anchor.epochIndex);
    if (!epoch || epoch.state === "open" || epoch.startFrame !== part.startFrame + anchor.epochStartFrame || clock.endFrame > epoch.frameCount) {
      return { ...base, reason: "clock-outside-audio" };
    }
    const hostStart = BigInt(clock.hostStartNs!);
    const hostDuration = Number(BigInt(clock.hostEndNs!) - hostStart);
    const offset = part.startFrame + anchor.epochStartFrame + clock.startFrame;
    const map = (ns: bigint) => (offset + Number(ns - hostStart) / hostDuration * (clock.endFrame - clock.startFrame)) / 24_000;
    const start = map(startNs);
    const end = map(endNs);
    base.clockAnchorIds = [anchor.id];
    base.intervals = [{ start, end }];
    if (offset < part.startFrame || anchor.epochStartFrame + clock.endFrame > part.frameCount) return { ...base, reason: "clock-outside-audio" };
    const minDelay = calibration?.indicatorDelayMinSeconds ?? 0;
    const maxDelay = calibration?.indicatorDelayMaxSeconds ?? 0;
    const error = calibration?.conversionErrorSeconds ?? 0;
    const earliest = start - maxDelay - error;
    const latest = end - minDelay + error;
    const overlapping = segments.filter((segment) => segment.start <= latest && segment.end >= earliest);
    const ids = new Set(overlapping.map((segment) => segment.speaker!));
    if (ids.size !== 1) return { ...base, reason: ids.size ? "ambiguous-asr-window" : "no-system-speech" };
    base.speakerId = [...ids][0];
    if (!calibration) return { ...base, reason: "uncalibrated-timing" };
    if (observation.self !== "remote") return { ...base, reason: observation.self === "local" ? "local-participant" : "unknown-self" };
    if (observation.provenance !== "zoom-only") return { ...base, reason: "unproven-system-source" };
    if (observation.singleSpeaker !== true) return { ...base, reason: "unproven-single-speaker" };
    // Full read interval and every allowed timing shift must stay inside one
    // speech segment; a coarse/short segment cannot supply stable attribution.
    if (!overlapping.some((segment) => segment.start <= earliest && segment.end >= latest &&
      segment.end - segment.start >= calibration.minimumEpisodeSeconds)) return { ...base, reason: "unstable-timing-window" };
    return { ...base, status: "accepted", reason: "validated-evidence" };
  });
  const bySpeaker = new Map<string, ZoomSpeakerDecision[]>();
  for (const decision of decisions) {
    if (!decision.speakerId) continue;
    const group = bySpeaker.get(decision.speakerId) ?? [];
    group.push(decision);
    bySpeaker.set(decision.speakerId, group);
  }
  for (const group of bySpeaker.values()) {
    const observations = group.flatMap((decision) => input.observations.filter((observation) => decision.observationIds.includes(observation.id)));
    const identities = new Set(observations.map((observation) => `${observation.sessionId}/${observation.instanceKey}/${observation.nameRevision}`));
    const names = new Set(observations.map((observation) => observation.displayName));
    const episodes = new Set(group.filter((decision) => decision.status === "accepted").flatMap((decision) => input.observations.filter((observation) => decision.observationIds.includes(observation.id)).map((observation) => observation.episodeId)));
    const reason = names.size > 1 ? "conflicting-names" : identities.size > 1 ? "conflicting-instances" :
      calibration && episodes.size < calibration.minimumIndependentEpisodes ? "insufficient-independent-episodes" : null;
    for (const decision of group) {
      // Preserve the concrete rejection when the acceptance policy is unavailable.
      if (reason && (reason.startsWith("conflicting") || decision.status === "accepted")) {
        decision.status = "rejected";
        decision.reason = reason;
      }
    }
  }
  // One AX instance mapping to several ASR clusters may be multiple people at
  // one device. Reject the whole identity rather than repairing diarization.
  const instanceSpeakers = new Map<string, Set<string>>();
  for (const decision of decisions) {
    if (!decision.speakerId) continue;
    const observation = input.observations.find((item) => item.id === decision.observationIds[0])!;
    const identity = `${observation.sessionId}/${observation.instanceKey}/${observation.nameRevision}`;
    const ids = instanceSpeakers.get(identity) ?? new Set();
    ids.add(decision.speakerId);
    instanceSpeakers.set(identity, ids);
  }
  for (const decision of decisions) {
    const observation = input.observations.find((item) => item.id === decision.observationIds[0])!;
    if ((instanceSpeakers.get(`${observation.sessionId}/${observation.instanceKey}/${observation.nameRevision}`)?.size ?? 0) > 1) {
      decision.status = "rejected";
      decision.reason = "instance-multiple-clusters";
    }
  }
  return decisions;
}
