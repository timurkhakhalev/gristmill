import type { MeetingPlatformObservation } from "../../../../src/contracts/meetingRecording.js";

const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { randomUUID }: typeof import("node:crypto") = require("node:crypto");

const {
  matchMeetingPlatformSpeakers,
}: typeof import("../../../../src/helpers/meetingPlatformMatcher.ts") = require("../../../../src/helpers/meetingPlatformMatcher.ts");

const recordingId = randomUUID();

function observation(
  displayName: string,
  self: MeetingPlatformObservation["self"],
  overrides: Partial<MeetingPlatformObservation> = {}
): MeetingPlatformObservation {
  return {
    platform: "google-meet",
    bindingId: randomUUID(),
    activeParticipantIds: [],
    clockGeneration: randomUUID(),
    clockUncertaintyNs: "0",
    id: randomUUID(),
    recordingId,
    sessionId: randomUUID(),
    instanceKey: `${displayName}-tile`,
    nameRevision: 1,
    episodeId: randomUUID(),
    displayName,
    windowMode: "unknown",
    activity: "candidate",
    readStartHostNs: "1000000000",
    readEndHostNs: "2000000000",
    self,
    singleSpeaker: null,
    provenance: "system-wide",
    reason: "activity-unconfirmed",
    ...overrides,
  };
}

function match(
  observations: MeetingPlatformObservation[],
  speech: Record<string, number> = { "system:Speaker 1": 1752, "system:Speaker 2": 48 }
) {
  let start = 0;

  const segments = Object.entries(speech).map(([speaker, seconds]) => {
    const segment = { speaker, text: "Speech", start, end: start + seconds };
    start += seconds;

    return segment;
  });

  segments.push({ speaker: "mic", text: "Local", start, end: start + 600 });

  return matchMeetingPlatformSpeakers({
    transcript: { text: "Synthetic", segments },
    observations,
    anchors: [],
    epochs: [],
    partOffsets: [],
  }).filter((decision) => decision.status === "accepted");
}

const oneToOne = () => [
  observation("Synthetic Host", "local"),
  observation("Synthetic Guest", "unknown"),
  observation("Synthetic Guest", "unknown"),
];

test("a one-to-one browser call names only the dominant system voice without clock activity", () => {
  const [decision] = match(oneToOne());
  assert.equal(decision.speakerId, "system:Speaker 1");
  assert.equal(decision.displayName, "Synthetic Guest");
  assert.equal(decision.reason, "sole-remote-participant");
  assert.deepEqual(decision.clockAnchorIds, []);
  assert.equal(decision.observationIds.length, 2);
  assert.equal(match([observation("Synthetic Guest", "unknown", { platform: "telemost" })]).length, 1);

  const zoomNotRunning = observation("", "unknown", {
    platform: "zoom",
    activity: "unavailable",
    instanceKey: "unavailable",
    clockGeneration: null,
  });

  assert.equal(match([...oneToOne(), zoomNotRunning]).length, 1);
});

test("several remote names, unnamed tiles, a shared local name or Zoom cannot use the one-to-one rule", () => {
  const cases: MeetingPlatformObservation[][] = [
    [...oneToOne(), observation("Second Guest", "unknown")],
    [...oneToOne(), observation("", "unknown")],
    [observation("Same Name", "local"), observation("Same Name", "unknown")],
    oneToOne().map((o) => ({ ...o, platform: "zoom" as const, clockGeneration: null })),
    [...oneToOne(), observation("Synthetic Guest", "unknown", { platform: "telemost" })],
  ];

  for (const observations of cases) assert.deepEqual(match(observations), []);
});

test("a balanced system voice split or too little speech abstains", () => {
  assert.deepEqual(match(oneToOne(), { "system:Speaker 1": 600, "system:Speaker 2": 400 }), []);
  assert.deepEqual(match(oneToOne(), { "system:Speaker 1": 9 }), []);
  assert.equal(match(oneToOne(), { "system:Speaker 1": 90, "system:Speaker 2": 10 }).length, 1);
});
