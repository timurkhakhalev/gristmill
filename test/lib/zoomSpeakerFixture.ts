import { randomUUID } from "node:crypto";
import type {
  MeetingAudioClockAnchor,
  MeetingPlatformObservation,
} from "../../src/contracts/meetingRecording.js";

export function zoomSpeakerFixture(recordingId: string) {
  const sessionId = randomUUID();
  const generation = randomUUID();

  // Native-shaped transition -> second-read confirmation -> bounded continued
  // activity -> end. No remote/self/source/calibration evidence is invented.
  const observations: MeetingPlatformObservation[] = [1, 5, 9].flatMap((start) => {
    const episodeId = randomUUID();

    const ranges: Array<[MeetingPlatformObservation["activity"], number, number]> = [
      ["candidate", start, start + 0.01],
      ["explicit", start + 0.01, start + 0.5],
      ["explicit", start + 0.5, start + 1.5],
      ["explicit", start + 1.5, start + 2.5],
      ["end", start + 2.5, start + 3],
    ];

    return ranges.map(([activity, begin, end]) => ({
      platform: "zoom",
      bindingId: sessionId,
      activeParticipantIds: activity === "explicit" || activity === "end" ? ["fixture-tile"] : [],
      clockGeneration: null,
      clockUncertaintyNs: "0",
      id: randomUUID(),
      recordingId,
      sessionId,
      instanceKey: "fixture-tile",
      nameRevision: 1,
      episodeId,
      displayName: "Synthetic Guest",
      windowMode: "full",
      activity,
      readStartHostNs: String(Math.round(begin * 1e9)),
      readEndHostNs: String(Math.round(end * 1e9)),
      self: "unknown",
      singleSpeaker: null,
      provenance: "system-wide",
      reason: activity === "candidate" ? "activity-transition" : null,
    }));
  });

  const anchors: MeetingAudioClockAnchor[] = Array.from({ length: 14 }, (_, i) => ({
    id: randomUUID(),
    recordingId,
    epochIndex: 0,
    epochStartFrame: 0,
    clock: {
      type: "clock",
      generation,
      startFrame: i * 24_000,
      endFrame: (i + 1) * 24_000,
      hostStartNs: String(i * 1e9),
      hostEndNs: String((i + 1) * 1e9),
      timebaseNumer: 1,
      timebaseDenom: 1,
      conversion: "uncalibrated",
      reason: null,
    },
  }));

  const transcript = {
    text: "Speech Speech Speech",
    segments: [1, 5, 9].map((start) => ({
      start: start - 0.5,
      end: start + 2.5,
      text: "Speech",
      speaker: "system:fixture",
    })),
  };

  return { observations, anchors, transcript };
}
