const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { clearBbCaches } = require("../../../../src/helpers/bbCli.ts");
const { createBbTextConversation } = require("../../../../src/helpers/bbSummary.ts");
const { createMeetingTextConversation } = require("../../../../src/helpers/meetingSummary.ts");
const { suggestMeetingSpeakerNames } = require("../../../../src/helpers/meetingSpeakerNaming.ts");
const { requestMeetingJson } = require("../../../../src/helpers/meetingJsonRepair.ts");
const { validateMeetingTasks } = require("../../../../src/helpers/meetingSummarySections.ts");

const summaryConfig = {
  instruction: "Use only the supplied transcript evidence.",
  reasoningMode: "providers",
  provider: "openai",
  model: "gpt-4o-mini",
  credentialRef: "OPENAI_API_KEY",
} as const;

const namingInput = {
  meetingTitle: "Release review",
  participants: [{ name: "Calendar Alice", email: "alice@example.com" }],
  segments: [{
    id: "source-run:0",
    speakerId: "speaker_0",
    speakerName: null,
    text: "I am Alice. The complete segment must be sent without truncation.",
  }],
};

test("selected provider repairs schema-invalid speaker JSON once in the same conversation", async () => {
  const generated: Array<Record<string, any>> = [];
  const built: unknown[] = [];
  const invalidResponse = '{"speakers":[{"speakerId":"speaker_other","name":"Alice"}]}';
  const replies = [
    invalidResponse,
    '{"speakers":[{"speakerId":"speaker_0","name":"Alice"}]}',
  ];
  const conversation = await createMeetingTextConversation(summaryConfig, {
    getAIModel: async (...args: unknown[]) => { built.push(args); return { selectedProviderModel: true }; },
    generateText: async (options: Record<string, any>) => {
      generated.push(options);
      return { text: replies.shift()! };
    },
    processLocalText: async () => { throw new Error("Local route must not be used"); },
    getCredential: (reference: string | undefined, provider: string) => {
      assert.equal(reference, "OPENAI_API_KEY");
      assert.equal(provider, "openai");
      return "test-credential";
    },
  }, new AbortController().signal);

  const result = await suggestMeetingSpeakerNames(namingInput, conversation);
  assert.deepEqual(result, [{ speakerId: "speaker_0", name: "Alice" }]);
  assert.equal(built.length, 1);
  assert.deepEqual(built[0], ["openai", "gpt-4o-mini", "test-credential", undefined, { disableThinking: undefined }]);
  assert.equal(generated.length, 2);
  assert.equal(generated[0].model, generated[1].model);
  assert.equal(generated[0].maxRetries, 0);
  assert.equal(generated[1].maxRetries, 0);
  assert.deepEqual(JSON.parse(generated[0].messages[0].content), namingInput);
  assert.equal(generated[1].messages.length, 3);
  assert.equal(generated[1].messages[1].content, invalidResponse);
  assert.match(generated[1].messages[2].content, /Previous response:/);
  assert.match(generated[1].messages[2].content, /speaker ID was not unknown/);
  assert.match(generated[1].messages[2].content, /speaker_other/);
  assert.equal(generated[0].messages[0].content, JSON.stringify(namingInput));
});

test("speaker JSON schema and domain failures get one repair, then stop", async () => {
  const invalidReplies = [
    "not json",
    JSON.stringify({ speakers: [{ speakerId: "speaker_unknown", name: "Alice" }] }),
    JSON.stringify({ speakers: [{ speakerId: "speaker_0", name: "Alice" }, { speakerId: "speaker_0", name: "A." }] }),
    JSON.stringify({ speakers: [{ speakerId: "speaker_0", name: "   " }] }),
    JSON.stringify({ speakers: [{ speakerId: "speaker_0", name: "Alice", confidence: 1 }] }),
    JSON.stringify({ speakers: [], extra: true }),
  ];
  for (const invalid of invalidReplies) {
    let turns = 0;
    const repaired = await suggestMeetingSpeakerNames(namingInput, {
      send: async () => ({ text: turns++ === 0 ? invalid : '{"speakers":[]}', refusal: false }),
    });
    assert.deepEqual(repaired, [], `repair should accept a valid omission after ${invalid}`);
    assert.equal(turns, 2, "a malformed reply gets exactly one repair turn");

    let failedTurns = 0;
    await assert.rejects(
      suggestMeetingSpeakerNames(namingInput, { send: async () => { failedTurns += 1; return { text: invalid, refusal: false }; } }),
      (error: unknown) => (error as { code?: string }).code === "speaker-name-json-invalid",
    );
    assert.equal(failedTurns, 2, "the second invalid reply fails after one repair");
  }
});

test("refusal and transport failure do not trigger JSON repair", async () => {
  let turns = 0;
  await assert.rejects(
    suggestMeetingSpeakerNames(namingInput, {
      send: async () => { turns += 1; return { text: "I cannot identify speakers.", refusal: false }; },
    }),
    (error: unknown) => (error as { code?: string }).code === "speaker-name-refused",
  );
  assert.equal(turns, 1);

  turns = 0;
  await assert.rejects(suggestMeetingSpeakerNames(namingInput, {
    send: async () => { turns += 1; throw Object.assign(new Error("network unavailable"), { code: "TRANSIENT_NETWORK_ERROR" }); },
  }), /network unavailable/);
  assert.equal(turns, 1);

  turns = 0;
  await assert.rejects(suggestMeetingSpeakerNames(namingInput, {
    send: async () => { turns += 1; return { text: "", refusal: true }; },
  }), (error: unknown) => (error as { code?: string }).code === "speaker-name-refused");
  assert.equal(turns, 1);
});

test("bb naming repairs with tell on the original thread", async (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-bb-speaker-repair-"));
  const binary = path.join(directory, "bb-fake");
  const capture = path.join(directory, "calls.jsonl");
  const previousBinary = process.env.BB_CLI;
  const previousCapture = process.env.BB_FAKE_CAPTURE;
  const previousOutputs = process.env.BB_FAKE_OUTPUTS;
  process.env.BB_CLI = binary;
  process.env.BB_FAKE_CAPTURE = capture;
  process.env.BB_FAKE_OUTPUTS = JSON.stringify([
    '{"speakers":[{"speakerId":"speaker_else","name":"Alice"}]}',
    '{"speakers":[{"speakerId":"speaker_0","name":"Alice"}]}',
  ]);
  t.after(() => {
    if (previousBinary === undefined) delete process.env.BB_CLI;
    else process.env.BB_CLI = previousBinary;
    if (previousCapture === undefined) delete process.env.BB_FAKE_CAPTURE;
    else process.env.BB_FAKE_CAPTURE = previousCapture;
    if (previousOutputs === undefined) delete process.env.BB_FAKE_OUTPUTS;
    else process.env.BB_FAKE_OUTPUTS = previousOutputs;
    clearBbCaches();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "--version") process.stdout.write("0.44.0");
else if (args[0] === "thread" && args[1] === "tell") {
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    fs.appendFileSync(process.env.BB_FAKE_CAPTURE, JSON.stringify({ command: args[1], id: args[2], prompt }) + "\\n");
    out({ ok: true });
  });
} else if (args[0] === "thread" && args[1] === "log") {
  const after = Number(args[args.indexOf("--after-seq") + 1]);
  out(after === 0
    ? [{ seq: 1, type: "turn/completed", data: { status: "completed" } }]
    : [{ seq: 2, type: "item/agentMessage/delta", data: { delta: "reply" } }, { seq: 3, type: "turn/completed", data: { status: "completed" } }]);
} else if (args[0] === "thread" && args[1] === "output") {
  const outputs = JSON.parse(process.env.BB_FAKE_OUTPUTS);
  const calls = fs.readFileSync(process.env.BB_FAKE_CAPTURE, "utf8").trim().split("\\n").filter(Boolean);
  out({ output: outputs[calls.length - 1] });
} else throw new Error("Unexpected bb command: " + args.join(" "));
`, { mode: 0o700 });
  fs.writeFileSync(capture, "");
  clearBbCaches();

  const conversation = await createBbTextConversation({
    selection: { provider: "codex", model: "gpt-6-luna", reasoningLevel: "low" },
    environment: directory,
    threadId: "thr_original",
    promptPrefix: "Name unknown speakers only from transcript evidence.",
    saveThreadId: () => { throw new Error("A repair must reuse the saved thread"); },
    signal: new AbortController().signal,
  });
  const result = await suggestMeetingSpeakerNames(namingInput, conversation);
  assert.deepEqual(result, [{ speakerId: "speaker_0", name: "Alice" }]);
  const calls = fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => [call.command, call.id]), [["tell", "thr_original"], ["tell", "thr_original"]]);
  assert.match(calls[0].prompt, /^Name unknown speakers only from transcript evidence\.\n\n/);
  assert.deepEqual(JSON.parse(calls[0].prompt.split("\n\n").slice(1).join("\n\n")), namingInput);
  assert.match(calls[1].prompt, /^Name unknown speakers only from transcript evidence\.\n\n/);
  assert.match(calls[1].prompt, /speaker ID was not unknown/);
  assert.match(calls[1].prompt, /speaker_else/);
});

test("bb prioritized-task repair uses tell on the selected run's original thread", async (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-bb-task-repair-"));
  const binary = path.join(directory, "bb-fake");
  const capture = path.join(directory, "calls.jsonl");
  const previousBinary = process.env.BB_CLI;
  const previousCapture = process.env.BB_FAKE_CAPTURE;
  const previousOutputs = process.env.BB_FAKE_OUTPUTS;
  process.env.BB_CLI = binary;
  process.env.BB_FAKE_CAPTURE = capture;
  process.env.BB_FAKE_OUTPUTS = JSON.stringify([
    '{"HIGH":["Ship"],"MEDIUM":[],"LOW":[],"extra":true}',
    '{"HIGH":["Ship release"],"MEDIUM":[],"LOW":[]}',
  ]);
  t.after(() => {
    if (previousBinary === undefined) delete process.env.BB_CLI;
    else process.env.BB_CLI = previousBinary;
    if (previousCapture === undefined) delete process.env.BB_FAKE_CAPTURE;
    else process.env.BB_FAKE_CAPTURE = previousCapture;
    if (previousOutputs === undefined) delete process.env.BB_FAKE_OUTPUTS;
    else process.env.BB_FAKE_OUTPUTS = previousOutputs;
    clearBbCaches();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "--version") process.stdout.write("0.44.0");
else if (args[0] === "thread" && args[1] === "tell") {
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    fs.appendFileSync(process.env.BB_FAKE_CAPTURE, JSON.stringify({ command: args[1], id: args[2], prompt }) + "\\n");
    out({ ok: true });
  });
} else if (args[0] === "thread" && args[1] === "log") {
  const after = Number(args[args.indexOf("--after-seq") + 1]);
  out(after === 0
    ? [{ seq: 1, type: "turn/completed", data: { status: "completed" } }]
    : [{ seq: 2, type: "item/agentMessage/delta", data: { delta: "reply" } }, { seq: 3, type: "turn/completed", data: { status: "completed" } }]);
} else if (args[0] === "thread" && args[1] === "output") {
  const outputs = JSON.parse(process.env.BB_FAKE_OUTPUTS);
  const calls = fs.readFileSync(process.env.BB_FAKE_CAPTURE, "utf8").trim().split("\\n").filter(Boolean);
  out({ output: outputs[calls.length - 1] });
} else throw new Error("Unexpected bb command: " + args.join(" "));
`, { mode: 0o700 });
  fs.writeFileSync(capture, "");
  clearBbCaches();

  const input = JSON.stringify({ meetingTitle: "Release review", transcriptSegments: [{ text: "Ship release" }] });
  const conversation = await createBbTextConversation({
    selection: { provider: "codex", model: "gpt-6-luna", reasoningLevel: "low" },
    environment: directory,
    threadId: "thr_selected",
    promptPrefix: "Return only prioritized task JSON.",
    saveThreadId: () => { throw new Error("Repair must use the selected run thread"); },
    signal: new AbortController().signal,
  });
  const tasks = await requestMeetingJson({
    conversation,
    prompt: input,
    refusalCode: "meeting-task-refused",
    invalidCode: "meeting-task-json-invalid",
    validate: validateMeetingTasks,
  });
  assert.deepEqual(tasks, { HIGH: ["Ship release"], MEDIUM: [], LOW: [] });
  const calls = fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call: { command: string; id: string }) => [call.command, call.id]), [
    ["tell", "thr_selected"], ["tell", "thr_selected"],
  ]);
  assert.match(calls[0].prompt, /^Return only prioritized task JSON\.\n\n/);
  assert.equal(calls[0].prompt.split("\n\n").slice(1).join("\n\n"), input);
  assert.match(calls[1].prompt, /Correct your previous response/);
  assert.match(calls[1].prompt, /extra/);
});
