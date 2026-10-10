import { MEETING_SOLE_REMOTE_PARTICIPANT_REASON } from "../contracts/meetingRecording.js";
import type {
  MeetingAudioClockAnchor,
  MeetingRecordingEpochDto,
  MeetingTranscriptArtifact,
  MeetingPlatformDecision,
  MeetingPlatformObservation,
  MeetingPlatformTimingPolicy,
} from "../contracts/meetingRecording.js";

/** Initial policy: the 500 ms Zoom lag is a hypothesis from static client
 * inspection, not our measurement. Guards and three episodes are conservative
 * product rules, not an accuracy estimate. Labels remain editable suggestions. */
export const ZOOM_SPEAKER_TIMING_POLICY: MeetingPlatformTimingPolicy = {
  version: "zoom-activity-v1",
  origin: "initial-lag-hypothesis",
  indicatorDelaySeconds: 0.5,
  boundaryGuardSeconds: 0.5,
  clockContinuitySeconds: 0.001,
  clockRateToleranceSeconds: 0.002,
  minimumSpeechSeconds: 1,
  minimumIndependentEpisodes: 3,
};

export const MEET_SPEAKER_TIMING_POLICY: MeetingPlatformTimingPolicy = {
  ...ZOOM_SPEAKER_TIMING_POLICY,
  version: "google-meet-activity-v1",
  indicatorDelaySeconds: 0.3,
};

// Telemost renders the server VAD flag directly. Use the same initial 300 ms
// hypothesis as Meet; this is a working estimate, not a measured audio delay.
export const TELEMOST_SPEAKER_TIMING_POLICY: MeetingPlatformTimingPolicy = {
  ...MEET_SPEAKER_TIMING_POLICY,
  version: "telemost-activity-v1",
};

const policyFor = (platform: MeetingPlatformObservation["platform"]) =>
  platform === "zoom"
    ? ZOOM_SPEAKER_TIMING_POLICY
    : platform === "telemost"
      ? TELEMOST_SPEAKER_TIMING_POLICY
      : MEET_SPEAKER_TIMING_POLICY;

export interface MeetingPlatformMatcherInput {
  transcript: MeetingTranscriptArtifact;
  observations: MeetingPlatformObservation[];
  anchors: MeetingAudioClockAnchor[];
  epochs: Array<
    Pick<
      MeetingRecordingEpochDto,
      "recordingId" | "source" | "epochIndex" | "timelineStartFrame" | "frameCount" | "state"
    >
  >;
  partOffsets: Array<{ recordingId: string; startFrame: number; frameCount: number }>;
}

type Interval = { start: number; end: number };

const overlaps = (a: Interval, b: Interval) => a.start < b.end && a.end > b.start;

function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];

  for (const item of [...intervals].sort((a, b) => a.start - b.start)) {
    const previous = result.at(-1);

    if (previous && item.start <= previous.end + 1 / 24_000)
      previous.end = Math.max(previous.end, item.end);
    else result.push({ ...item });
  }

  return result;
}

type IntervalMapping = { interval: Interval; ids: string[]; binding: string };

type MapFailure =
  | "clock-uncertainty"
  | "clock-generation-missing"
  | "clock-outside-audio"
  | "clock-rate-mismatch"
  | "clock-discontinuity"
  | "clock-coverage-gap"
  | "activity-unconfirmed";

function isMapFailure(value: IntervalMapping | MapFailure): value is MapFailure {
  return typeof value === "string";
}

/** Map only through contiguous actual frame ranges in one saved source epoch.
 * Independent anchors may join only when both frame and host boundaries agree. */
function mapInterval(
  input: MeetingPlatformMatcherInput,
  observation: MeetingPlatformObservation
): IntervalMapping | MapFailure {
  const policy = policyFor(observation.platform);

  if (BigInt(observation.clockUncertaintyNs) > 25_000_000n) return "clock-uncertainty";

  if (observation.platform !== "zoom" && !observation.clockGeneration)
    return "clock-generation-missing";
  const part = input.partOffsets.find((item) => item.recordingId === observation.recordingId);

  if (!part) return "clock-outside-audio";
  let cursor = BigInt(observation.readStartHostNs);
  const end = BigInt(observation.readEndHostNs);

  // Anchors without both host bounds cannot map audio; drop them up front so
  // the rest of the mapping can rely on the non-null values.
  const anchors = input.anchors
    .filter(
      (a): a is MeetingAudioClockAnchor & { clock: { hostStartNs: string; hostEndNs: string } } =>
        a.recordingId === observation.recordingId &&
        (!observation.clockGeneration || a.clock.generation === observation.clockGeneration) &&
        a.clock.reason === null &&
        a.clock.hostStartNs !== null &&
        a.clock.hostEndNs !== null
    )
    .sort((a, b) => (BigInt(a.clock.hostStartNs) < BigInt(b.clock.hostStartNs) ? -1 : 1));

  let previous: MeetingAudioClockAnchor | undefined;
  let startSeconds: number | undefined;
  let endSeconds = 0;
  const ids: string[] = [];

  while (cursor < end) {
    const matching = anchors.filter(
      (a) => BigInt(a.clock.hostStartNs) <= cursor && BigInt(a.clock.hostEndNs) > cursor
    );

    if (matching.length !== 1) return "clock-coverage-gap";
    const a = matching[0];
    const c = a.clock;

    const epoch = input.epochs.find(
      (e) =>
        e.recordingId === a.recordingId && e.source === "system" && e.epochIndex === a.epochIndex
    );

    if (
      !epoch ||
      epoch.state === "open" ||
      epoch.timelineStartFrame !== part.startFrame + a.epochStartFrame ||
      c.endFrame > epoch.frameCount ||
      a.epochStartFrame + c.endFrame > part.frameCount
    )
      return "clock-outside-audio";
    const hostStart = BigInt(c.hostStartNs);
    const hostEnd = BigInt(c.hostEndNs);
    const duration = Number(hostEnd - hostStart) / 1e9;

    if (
      duration <= 0 ||
      Math.abs(duration - (c.endFrame - c.startFrame) / 24_000) > policy.clockRateToleranceSeconds
    )
      return "clock-rate-mismatch";

    if (
      previous &&
      (previous.epochIndex !== a.epochIndex ||
        previous.clock.generation !== c.generation ||
        previous.clock.endFrame !== c.startFrame ||
        previous.clock.hostEndNs === null ||
        Math.abs(Number(hostStart - BigInt(previous.clock.hostEndNs))) / 1e9 >
          policy.clockContinuitySeconds)
    )
      return "clock-discontinuity";

    const map = (ns: bigint) =>
      (part.startFrame +
        a.epochStartFrame +
        c.startFrame +
        (Number(ns - hostStart) / 1e9 / duration) * (c.endFrame - c.startFrame)) /
      24_000;

    startSeconds ??= map(cursor);
    cursor = end < hostEnd ? end : hostEnd;
    endSeconds = map(cursor);
    ids.push(a.id);
    previous = a;
  }

  return startSeconds === undefined || !previous
    ? "activity-unconfirmed"
    : {
        interval: { start: startSeconds, end: endSeconds },
        ids,
        binding: `${observation.recordingId}/${previous.epochIndex}/${previous.clock.generation}`,
      };
}

const SOLE_REMOTE_MINIMUM_SHARE = 0.9;

const SOLE_REMOTE_MINIMUM_SECONDS = 10;

/** One-to-one browser calls: every non-local tile in the note has the same
 * name and one system voice holds almost all system speech. Small clusters
 * stay unnamed; a second named participant or a balanced voice split abstains. */
function soleRemoteDecision(
  all: MeetingPlatformObservation[],
  system: NonNullable<MeetingTranscriptArtifact["segments"]>
): MeetingPlatformDecision | null {
  // "unavailable" marks a collector without a readable call, not a participant.
  const observations = all.filter((o) => o.activity !== "unavailable");
  const platforms = new Set(observations.map((o) => o.platform));
  const [platform] = platforms;

  if (platforms.size !== 1 || !platform || platform === "zoom") return null;

  const localNames = new Set(
    observations.filter((o) => o.self === "local" && o.displayName).map((o) => o.displayName)
  );

  const remote = observations.filter((o) => o.self !== "local" && !localNames.has(o.displayName));
  const names = new Set(remote.map((o) => o.displayName));
  const [displayName] = names;

  if (!remote.length || names.size !== 1 || !displayName) return null;
  const seconds = new Map<string, number>();

  for (const segment of system)
    if (segment.speaker)
      seconds.set(
        segment.speaker,
        (seconds.get(segment.speaker) ?? 0) + segment.end - segment.start
      );

  const total = [...seconds.values()].reduce((sum, value) => sum + value, 0);
  const [speakerId, speech] = [...seconds].sort((a, b) => b[1] - a[1])[0] ?? [];

  if (
    !speakerId ||
    speech === undefined ||
    speech < SOLE_REMOTE_MINIMUM_SECONDS ||
    speech < total * SOLE_REMOTE_MINIMUM_SHARE
  )
    return null;

  return {
    platform,
    speakerId,
    displayName,
    status: "accepted",
    reason: MEETING_SOLE_REMOTE_PARTICIPANT_REASON,
    observationIds: remote.map((o) => o.id),
    clockAnchorIds: [],
    intervals: [],
    timingPolicy: { ...policyFor(platform) },
  };
}

/** Run-local agreement names clusters; tile/name strings never become voice IDs. */
export function matchMeetingPlatformSpeakers(
  input: MeetingPlatformMatcherInput
): MeetingPlatformDecision[] {
  const segments = (input.transcript.segments ?? []).filter(
    (s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start
  );

  const system = segments.filter((s) => s.speaker?.startsWith("system:"));
  const local = segments.filter((s) => s.speaker === "mic" || s.speaker?.startsWith("mic:"));

  const localNames = new Set(
    input.observations.filter((o) => o.self === "local").map((o) => o.displayName)
  );

  const episodes = new Map<string, MeetingPlatformObservation[]>();

  for (const o of input.observations) {
    const key = `${o.recordingId}/${o.platform}/${o.bindingId}/${o.sessionId}/${o.episodeId}/${o.instanceKey}/${o.nameRevision}`;
    episodes.set(key, [...(episodes.get(key) ?? []), o]);
  }

  const decisions = [...episodes.values()].map((observations): MeetingPlatformDecision => {
    const o = observations[0];
    const policy = policyFor(o.platform);

    const decision: MeetingPlatformDecision = {
      platform: o.platform,
      speakerId: null,
      displayName: o.displayName || null,
      status: "rejected",
      reason: o.reason ?? "activity-unconfirmed",
      observationIds: observations.map((v) => v.id),
      clockAnchorIds: [],
      intervals: [],
      timingPolicy: { ...policy },
    };

    const explicit = observations.filter((v) => v.activity === "explicit" || v.activity === "end");

    if (!explicit.length) return decision;

    if (
      explicit.some(
        (sample) =>
          sample.activeParticipantIds.length !== 1 ||
          sample.activeParticipantIds[0] !== sample.instanceKey
      )
    ) {
      return { ...decision, reason: "multiple-active-participants" };
    }

    let clockReason = "clock-coverage-gap";
    const rangesByBinding = new Map<string, Interval[]>();

    for (const sample of explicit) {
      if (
        input.observations.some(
          (other) =>
            other.platform === sample.platform &&
            other.bindingId === sample.bindingId &&
            other.instanceKey !== sample.instanceKey &&
            (other.activity === "explicit" || other.activity === "end") &&
            BigInt(other.readStartHostNs) < BigInt(sample.readEndHostNs) &&
            BigInt(other.readEndHostNs) > BigInt(sample.readStartHostNs)
        )
      ) {
        clockReason = "multiple-active-participants";
        continue;
      }

      if (
        input.observations.some(
          (unknown) =>
            unknown.recordingId === sample.recordingId &&
            (unknown.activity === "unavailable" || unknown.activity === "ambiguous") &&
            BigInt(unknown.readStartHostNs) < BigInt(sample.readEndHostNs) &&
            BigInt(unknown.readEndHostNs) > BigInt(sample.readStartHostNs)
        )
      ) {
        clockReason = "activity-coverage-gap";
        continue;
      }

      const mapped = mapInterval(input, sample);

      if (isMapFailure(mapped)) {
        clockReason = mapped;
        continue;
      }

      rangesByBinding.set(mapped.binding, [
        ...(rangesByBinding.get(mapped.binding) ?? []),
        mapped.interval,
      ]);
      decision.clockAnchorIds.push(...mapped.ids);
    }

    decision.clockAnchorIds = [...new Set(decision.clockAnchorIds)];
    decision.intervals = [...rangesByBinding.values()].flatMap(union);

    if (!decision.intervals.length) return { ...decision, reason: clockReason };

    // Trim uncertain turn boundaries, shift by the stated lag hypothesis. Do
    // not extrapolate through startup, tail or a missing anchor/AX interval.
    const cores = decision.intervals
      .map((i) => ({
        start: i.start - policy.indicatorDelaySeconds + policy.boundaryGuardSeconds,
        end: i.end - policy.indicatorDelaySeconds - policy.boundaryGuardSeconds,
      }))
      .filter((i) => i.end > i.start);

    const speech = system.filter((s) => cores.some((i) => overlaps(s, i)));

    const speakers = new Set(speech.flatMap((s) => (s.speaker !== null ? [s.speaker] : [])));

    if (speakers.size !== 1)
      return { ...decision, reason: speakers.size ? "ambiguous-asr-window" : "no-system-speech" };
    decision.speakerId = [...speakers][0] ?? null;

    if (o.self === "local" || localNames.has(o.displayName))
      return { ...decision, reason: "local-participant" };

    if (local.some((s) => cores.some((i) => overlaps(s, i))))
      return { ...decision, reason: "local-speech-overlap" };

    const duplicate = input.observations.some(
      (other) =>
        other.recordingId === o.recordingId &&
        other.sessionId === o.sessionId &&
        other.instanceKey !== o.instanceKey &&
        other.displayName === o.displayName &&
        explicit.some(
          (sample) =>
            BigInt(other.readStartHostNs) < BigInt(sample.readEndHostNs) &&
            BigInt(other.readEndHostNs) > BigInt(sample.readStartHostNs)
        )
    );

    if (duplicate) return { ...decision, reason: "duplicate-display-name" };

    const speechSeconds = union(
      speech.flatMap((s) =>
        cores
          .filter((i) => overlaps(s, i))
          .map((i) => ({ start: Math.max(s.start, i.start), end: Math.min(s.end, i.end) }))
      )
    ).reduce((sum, i) => sum + i.end - i.start, 0);

    if (speechSeconds < policy.minimumSpeechSeconds)
      return { ...decision, reason: "insufficient-stable-speech" };

    return { ...decision, status: "accepted", reason: "repeated-activity-agreement" };
  });

  for (const decision of decisions) {
    const policy = policyFor(decision.platform);

    if (!decision.speakerId) continue;
    const sameSpeaker = decisions.filter((d) => d.speakerId === decision.speakerId);
    const names = new Set(sameSpeaker.map((d) => d.displayName));

    // A name that reliably points at different clusters is ambiguous, even if
    // AX objects were recreated. Sequential recreation alone is harmless.
    const nameSpeakers = new Set(
      decisions
        .filter((d) => d.displayName === decision.displayName && d.speakerId)
        .map((d) => d.speakerId)
    );

    const episodes = new Set(
      sameSpeaker
        .filter((d) => d.status === "accepted")
        .flatMap((d) =>
          input.observations
            .filter((o) => d.observationIds.includes(o.id))
            .map((o) => `${o.recordingId}/${o.sessionId}/${o.episodeId}`)
        )
    );

    const bouts = union(system.filter((s) => s.speaker === decision.speakerId));

    const supportedBouts = new Set(
      sameSpeaker
        .filter((d) => d.status === "accepted")
        .flatMap((d) =>
          bouts.flatMap((bout, index) =>
            d.intervals.some((i) =>
              overlaps(bout, {
                start: i.start - policy.indicatorDelaySeconds + policy.boundaryGuardSeconds,
                end: i.end - policy.indicatorDelaySeconds - policy.boundaryGuardSeconds,
              })
            )
              ? [index]
              : []
          )
        )
    );

    const reason =
      names.size > 1
        ? "conflicting-names"
        : nameSpeakers.size > 1
          ? "name-multiple-clusters"
          : sameSpeaker.some((d) => d.reason === "duplicate-display-name") ||
              input.observations.some(
                (o) =>
                  o.displayName === decision.displayName && o.reason === "duplicate-display-name"
              )
            ? "duplicate-display-name"
            : Math.min(episodes.size, supportedBouts.size) < policy.minimumIndependentEpisodes
              ? "insufficient-independent-episodes"
              : null;

    // Compute before mutating: episode counts must not depend on iteration order.
    if (
      reason &&
      (decision.status === "accepted" || reason !== "insufficient-independent-episodes")
    ) {
      decision.reason = reason;
    }
  }

  for (const d of decisions) if (d.reason !== "repeated-activity-agreement") d.status = "rejected";

  if (!decisions.some((d) => d.status === "accepted")) {
    const sole = soleRemoteDecision(input.observations, system);

    if (sole) decisions.push(sole);
  }

  return decisions;
}
