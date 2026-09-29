const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const { buildMeetingFollowUpSystemPrompt }: typeof import("../../../../src/helpers/meetingFollowUpPrompt.ts") = require("../../../../src/helpers/meetingFollowUpPrompt.ts");
const { requestMeetingJson }: typeof import("../../../../src/helpers/meetingJsonRepair.ts") = require("../../../../src/helpers/meetingJsonRepair.ts");
const { validateMeetingRecap, validateMeetingTasks }: typeof import("../../../../src/helpers/meetingSummarySections.ts") = require("../../../../src/helpers/meetingSummarySections.ts");

test("Follow-up receives only selected meeting evidence and stores through the editable action prompt", () => {
  const material = {
    meetingTitle: "Release review",
    manualNotes: "Confirm the rollout window.",
    transcriptSegments: [{
      id: "source:0", speakerId: "speaker-1", speakerName: "Alice", text: "I will check the build.", startTimestamp: 12.5,
    }],
    summary: null,
  };
  const prompt = buildMeetingFollowUpSystemPrompt("Write a short message in Russian.", material);
  assert.match(prompt, /Write a short message in Russian\./);
  assert.match(prompt, /Do not use earlier Chat messages or application context as meeting facts/);
  assert.match(prompt, /Do not call tools, send the draft/);
  const encoded = prompt.match(/\{[\s\S]*\}/)?.[0];
  assert.ok(encoded);
  assert.deepEqual(JSON.parse(encoded), material);
  assert.doesNotMatch(encoded, /calendar|email|attendee|generation date|older meeting/i);
});

test("prioritized task JSON repairs once in its existing selected-provider conversation", async () => {
  const turns: string[] = [];
  const replies = [
    JSON.stringify({ HIGH: ["Ship"], MEDIUM: [], LOW: [], extra: true }),
    JSON.stringify({ HIGH: ["Ship the release"], MEDIUM: [], LOW: [] }),
  ];
  const conversation = { send: async (prompt: string) => {
    turns.push(prompt);
    return { text: replies.shift()!, refusal: false };
  } };
  const tasks = await requestMeetingJson({
    conversation,
    prompt: "selected meeting input",
    refusalCode: "meeting-task-refused",
    invalidCode: "meeting-task-json-invalid",
    validate: validateMeetingTasks,
  });
  assert.deepEqual(tasks, { HIGH: ["Ship the release"], MEDIUM: [], LOW: [] });
  assert.equal(turns.length, 2);
  assert.equal(turns[0], "selected meeting input");
  assert.match(turns[1], /Correct your previous response/);
  assert.match(turns[1], /extra/);
});

test("Recap JSON repairs invalid limits once and refuses transport or refusal repair", async () => {
  let turns = 0;
  const recap = await requestMeetingJson({
    conversation: { send: async () => ({
      text: turns++ === 0
        ? JSON.stringify({ title: "x".repeat(59), bullets: [] })
        : JSON.stringify({ title: "Release", bullets: ["Ship Friday"] }),
      refusal: false,
    }) },
    prompt: "selected meeting input",
    refusalCode: "meeting-recap-refused",
    invalidCode: "meeting-recap-json-invalid",
    validate: validateMeetingRecap,
  });
  assert.deepEqual(recap, { title: "Release", bullets: ["Ship Friday"] });
  assert.equal(turns, 2);

  turns = 0;
  await assert.rejects(requestMeetingJson({
    conversation: { send: async () => { turns++; return { text: "I cannot do that.", refusal: false }; } },
    prompt: "input", refusalCode: "meeting-recap-refused", invalidCode: "meeting-recap-json-invalid",
    validate: validateMeetingRecap,
  }), (error: unknown) => (error as { code?: string }).code === "meeting-recap-refused");
  assert.equal(turns, 1);

  turns = 0;
  await assert.rejects(requestMeetingJson({
    conversation: { send: async () => { turns++; throw new Error("network unavailable"); } },
    prompt: "input", refusalCode: "meeting-task-refused", invalidCode: "meeting-task-json-invalid",
    validate: validateMeetingTasks,
  }), /network unavailable/);
  assert.equal(turns, 1);
});
