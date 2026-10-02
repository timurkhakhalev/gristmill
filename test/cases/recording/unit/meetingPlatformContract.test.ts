import test from "node:test";
import assert from "node:assert/strict";
import { meetingPlatformSchema, meetingSpeakerCorrectionSchema } from "../../../../src/contracts/meetingRecording.ts";
import { meetingTranscriptSegmentSchema } from "../../../../src/contracts/meetingCoordinator.ts";
import { noteTranscriptSchema } from "../../../../src/contracts/noteRead.ts";
import { meetingSpeakerNamingInputSchema } from "../../../../src/helpers/meetingSpeakerNaming.ts";
import { formatMeetingMaterial } from "../../../../src/helpers/meetingPromptMaterial.ts";

for (const platform of meetingPlatformSchema.options) test(`${platform} provenance survives coordinator, Notes and naming boundaries`, () => {
  const correction = meetingSpeakerCorrectionSchema.parse({ speakerId: "remote", profileId: null, displayName: "Guest", participantEmail: null, source: "platform", platform, revision: 1 });
  const segment = meetingTranscriptSegmentSchema.parse({ id: "turn", text: "Hello", source: "system", speakerPlatform: correction.platform });
  const note = noteTranscriptSchema.parse({ note_id: 1, status: "ready", timeline: { unit: "ms", duration_ms: 1000, basis: "concatenated_recording_time", intentional_pauses: "excluded" },
    speakers: [{ id: "remote", name: "Guest", name_source: "platform", name_platform: segment.speakerPlatform, email: null, source: "system" }], text: "Hello", segments: null, diagnostics: [] });
  const naming = meetingSpeakerNamingInputSchema.parse({ meetingTitle: null, participants: [], segments: [{ id: "turn", speakerId: "remote", speakerName: "Guest", speakerNameSource: "platform", speakerNamePlatform: note.speakers[0].name_platform, text: "Hello" }] });
  assert.equal(naming.segments[0].speakerNamePlatform, platform);
  assert.match(formatMeetingMaterial({ meetingTitle: naming.meetingTitle, transcriptSegments: naming.segments }), /name source=platform/);
});

test("unsupported platform names fail at each public provenance boundary", () => {
  assert.equal(meetingPlatformSchema.safeParse("teams").success, false);
  assert.equal(meetingTranscriptSegmentSchema.safeParse({ id: "turn", text: "Hello", source: "system", speakerPlatform: "teams" }).success, false);
  assert.equal(meetingSpeakerNamingInputSchema.safeParse({ meetingTitle: null, participants: [], segments: [{ id: "turn", speakerId: "remote", speakerName: "Guest", speakerNamePlatform: "teams", text: "Hello" }] }).success, false);
});
