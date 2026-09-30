const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { parseDeepgramFileResponse }: typeof import("../../../../src/helpers/deepgramFileTranscription.ts") = require("../../../../src/helpers/deepgramFileTranscription.ts");
const { formatMeetingMaterial }: typeof import("../../../../src/helpers/meetingPromptMaterial.ts") = require("../../../../src/helpers/meetingPromptMaterial.ts");
const { suggestMeetingSpeakerNames, MEETING_SPEAKER_NAMING_INSTRUCTION }: typeof import("../../../../src/helpers/meetingSpeakerNaming.ts") = require("../../../../src/helpers/meetingSpeakerNaming.ts");

test("Deepgram preserves speaker changes inside an utterance, punctuation and original boundaries", () => {
  const raw = { results: {
    channels: [{ alternatives: [{ transcript: "Max, update? We shipped. Thank you." }] }],
    utterances: [
      { speaker: 0, start: 0, end: 3, transcript: "Max, update? We shipped.", words: [
        { speaker: 0, word: "max", punctuated_word: "Max,", start: 0, end: 0.5 },
        { speaker: 0, word: "update", punctuated_word: "update?", start: 0.6, end: 1 },
        { speaker: 1, word: "we", punctuated_word: "We", start: 1.5, end: 2 },
        { speaker: 1, word: "shipped", punctuated_word: "shipped.", start: 2.1, end: 3 },
      ] },
      { speaker: 1, start: 9, end: 10, transcript: "Thank you." },
    ],
  } };
  const original = JSON.stringify(raw);
  const result = parseDeepgramFileResponse(raw, true);
  assert.equal(result.success, true);
  assert.deepEqual(result.segments, [
    { speaker: "Speaker 1", text: "Max, update?", start: 0, end: 1 },
    { speaker: "Speaker 2", text: "We shipped.", start: 1.5, end: 3 },
    { speaker: "Speaker 2", text: "Thank you.", start: 9, end: 10 },
  ]);
  assert.equal(JSON.stringify(raw), original, "raw provider response is preserved");
  raw.results.utterances[0].words![2].speaker = -1;
  assert.equal(parseDeepgramFileResponse(raw, true).success, false, "invalid word labels cannot silently become utterance labels");
});

test("naming retains separate same-speaker turns, both times and correction origins", async () => {
  const segments = [
    { id: "run:0", speakerId: "mic", speakerName: "Owner", speakerNameSource: "user" as const, text: "Max, update?", start: 0, end: 1 },
    { id: "run:1", speakerId: "a", speakerName: "Old guess", speakerNameSource: "model" as const, text: "We shipped.", start: 2, end: 3 },
    { id: "run:2", speakerId: "a", speakerName: "Old guess", speakerNameSource: "model" as const, text: "The latency fell.", start: 9, end: 10 },
    { id: "run:3", speakerId: "b", speakerName: "Voice match", speakerNameSource: "voice" as const, text: "Thank you, Max.", start: 11, end: 12 },
  ];
  let prompt = "";
  const names = await suggestMeetingSpeakerNames({ meetingTitle: null, participants: [
    { name: "Max Smith", email: "max.smith@example.com" },
    { name: "Max Jones", email: "max.jones@example.com" },
  ], segments }, { send: async (text) => {
    prompt = text;
    return { text: '{"speakers":[{"speakerId":"Speaker 2","name":"Max"}]}', refusal: false };
  } });
  assert.deepEqual(names, [{ speakerId: "a", name: "Max" }]);
  assert.match(prompt, /Allowed output IDs: Speaker 2\./);
  assert.match(prompt, /name source=user/);
  assert.match(prompt, /name source=model/);
  assert.match(prompt, /name source=voice/);
  assert.match(prompt, /Speaker 2 \[0:02–0:03\]: "We shipped\."[\s\S]*Speaker 2 \[0:09–0:10\]: "The latency fell\."/);
  assert.match(MEETING_SPEAKER_NAMING_INSTRUCTION, /duplicate calendar names are not a reason to reject/);
  assert.match(MEETING_SPEAKER_NAMING_INSTRUCTION, /unambiguous handoff/);
  assert.match(MEETING_SPEAKER_NAMING_INSTRUCTION, /addressed thanks/);
  assert.match(MEETING_SPEAKER_NAMING_INSTRUCTION, /Nora could not attend/);
  assert.match(MEETING_SPEAKER_NAMING_INSTRUCTION, /conflicting addresses/);
  const empty = formatMeetingMaterial({ meetingTitle: null, manualNotes: "", summary: "", transcriptSegments: [] });
  assert.match(empty, /discard the previous saved summary/);
  assert.match(empty, /No speaker identities available/);
});
