const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const {
  buildMeetingFollowUpSystemPrompt,
}: typeof import("../../../../src/helpers/meetingFollowUpPrompt.ts") = require("../../../../src/helpers/meetingFollowUpPrompt.ts");

const {
  requestMeetingJson,
}: typeof import("../../../../src/helpers/meetingJsonRepair.ts") = require("../../../../src/helpers/meetingJsonRepair.ts");

const {
  validateMeetingRecap,
  validateMeetingTasks,
}: typeof import("../../../../src/helpers/meetingSummarySections.ts") = require("../../../../src/helpers/meetingSummarySections.ts");

test("Follow-up receives only selected meeting evidence and stores through the editable action prompt", () => {
  const material = {
    meetingTitle: "Release review",
    manualNotes: "Confirm the rollout window.",
    transcriptSegments: [
      {
        id: "source:0",
        speakerId: "speaker-1",
        speakerName: "Alice",
        text: "I will check the build.",
        startTimestamp: 12.5,
      },
    ],
    summary: null,
  };

  const prompt = buildMeetingFollowUpSystemPrompt("Write a short message in Russian.", material);
  assert.match(prompt, /Write a short message in Russian\./);
  assert.match(prompt, /Do not use earlier Chat messages or application context as meeting facts/);
  assert.match(prompt, /Do not call tools, send the draft/);
  assert.match(prompt, /Speaker 1 \[0:12\]: "I will check the build\."/);
  assert.doesNotMatch(prompt, /source:0|"speakerId":|"transcriptSegments":/);
});

test("Recap JSON repairs invalid limits once and refuses transport or refusal repair", async () => {
  let turns = 0;

  const recap = await requestMeetingJson({
    conversation: {
      send: async () => ({
        text:
          turns++ === 0
            ? JSON.stringify({ title: "x".repeat(59), bullets: [] })
            : JSON.stringify({ title: "Release", bullets: ["Ship Friday"] }),
        refusal: false,
      }),
    },
    prompt: "selected meeting input",
    refusalCode: "meeting-recap-refused",
    invalidCode: "meeting-recap-json-invalid",
    validate: validateMeetingRecap,
  });

  assert.deepEqual(recap, { title: "Release", bullets: ["Ship Friday"] });
  assert.equal(turns, 2);

  turns = 0;
  await assert.rejects(
    requestMeetingJson({
      conversation: {
        send: async () => {
          turns++;

          return { text: "I cannot do that.", refusal: false };
        },
      },
      prompt: "input",
      refusalCode: "meeting-recap-refused",
      invalidCode: "meeting-recap-json-invalid",
      validate: validateMeetingRecap,
    }),
    (error: unknown) => (error as { code?: string }).code === "meeting-recap-refused"
  );
  assert.equal(turns, 1);

  turns = 0;
  await assert.rejects(
    requestMeetingJson({
      conversation: {
        send: async () => {
          turns++;
          throw new Error("network unavailable");
        },
      },
      prompt: "input",
      refusalCode: "meeting-task-refused",
      invalidCode: "meeting-task-json-invalid",
      validate: validateMeetingTasks,
    }),
    /network unavailable/
  );
  assert.equal(turns, 1);
});
