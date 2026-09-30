const { formatMeetingMaterial } = require("../../../../src/helpers/meetingPromptMaterial.ts");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { clearBbCaches } = require("../../../../src/helpers/bbCli.ts");
const { createBbTextConversation } = require("../../../../src/helpers/bbSummary.ts");
const { createMeetingTextConversation } = require("../../../../src/helpers/meetingSummary.ts");
const { suggestMeetingSpeakerNames } = require("../../../../src/helpers/meetingSpeakerNaming.ts");
const { MEETING_TASKS_INSTRUCTION, replaceMeetingTasks, replaceMeetingRecap }: typeof import("../../../../src/helpers/meetingSummarySections.ts") = require("../../../../src/helpers/meetingSummarySections.ts");

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
    '{"speakers":[{"speakerId":"Speaker 1","name":"Alice"}]}',
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
  assert.ok(generated[0].messages[0].content.endsWith(formatMeetingMaterial({ ...namingInput, transcriptSegments: namingInput.segments })));
  assert.equal(generated[1].messages.length, 3);
  assert.equal(generated[1].messages[1].content, invalidResponse);
  assert.match(generated[1].messages[2].content, /Previous response:/);
  assert.match(generated[1].messages[2].content, /Allowed unknown IDs: Speaker 1/);
  assert.match(generated[1].messages[2].content, /speaker_other/);
  assert.match(generated[0].messages[0].content, /Allowed output IDs: Speaker 1/);
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-bb-speaker-repair-"));
  const binary = path.join(directory, "bb-fake");
  const capture = path.join(directory, "calls.jsonl");
  const previousBinary = process.env.BB_CLI;
  const previousCapture = process.env.BB_FAKE_CAPTURE;
  const previousOutputs = process.env.BB_FAKE_OUTPUTS;
  process.env.BB_CLI = binary;
  process.env.BB_FAKE_CAPTURE = capture;
  process.env.BB_FAKE_OUTPUTS = JSON.stringify([
    '{"speakers":[{"speakerId":"speaker_else","name":"Alice"}]}',
    '{"speakers":[{"speakerId":"Speaker 1","name":"Alice"}]}',
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
  assert.ok(calls[0].prompt.endsWith(formatMeetingMaterial({ ...namingInput, transcriptSegments: namingInput.segments })));
  assert.match(calls[1].prompt, /^Name unknown speakers only from transcript evidence\.\n\n/);
  assert.match(calls[1].prompt, /Allowed unknown IDs: Speaker 1/);
  assert.match(calls[1].prompt, /speaker_else/);
});

test("BB reuses an unchanged transcript across conversation objects and sends changed source text", async (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-bb-context-"));
  const binary = path.join(directory, "bb-fake");
  const capture = path.join(directory, "calls.jsonl");
  const replyPlan = path.join(directory, "replies.json");
  const replies: Record<number, { text: string; status?: string; providerThreadId?: string }> = {};
  const previousBinary = process.env.BB_CLI;
  process.env.BB_CLI = binary;
  t.after(() => {
    if (previousBinary === undefined) delete process.env.BB_CLI;
    else process.env.BB_CLI = previousBinary;
    clearBbCaches();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(capture, "");
  fs.writeFileSync(replyPlan, "{}");
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const capture = ${JSON.stringify(capture)};
const calls = () => fs.readFileSync(capture, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
const reply = i => ({ text: "## TLDR\\nDocument", status: "completed", providerThreadId: "provider-original", ...JSON.parse(fs.readFileSync(${JSON.stringify(replyPlan)}, "utf8"))[i] });
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "--version") process.stdout.write("0.44.0");
else if (args[0] === "project" && args[1] === "create") out({ id: "proj_test" });
else if (args[0] === "project" && args[1] === "show") out({ id: "proj_test", sources: [{ path: ${JSON.stringify(directory)} }] });
else if (args[1] === "tell" || args[1] === "spawn") {
  let prompt = "";
  process.stdin.on("data", chunk => prompt += chunk);
  process.stdin.on("end", () => { fs.appendFileSync(capture, JSON.stringify(prompt) + "\\n"); out(args[1] === "spawn" ? { id: "thr_new" } : { ok: true }); });
} else if (args[1] === "log") {
  const after = Number(args[args.indexOf("--after-seq") + 1]);
  out(calls().flatMap((prompt, i) => [
    ...(prompt.includes("Context cleared marker") ? [{ seq: i * 5 + 1, type: "thread/context/cleared", data: {} }] : []),
    ...(prompt.includes("Compaction marker") ? [{ seq: i * 5 + 1, type: "thread/compacted", data: {} }] : []),
    { seq: i * 5 + 2, type: "client/turn/requested", data: { requestId: "request-" + i, input: [{ type: "text", text: prompt }] } },
    { seq: i * 5 + 3, type: "turn/input/accepted", data: { providerThreadId: reply(i).providerThreadId, clientRequestId: "request-" + i } },
    { seq: i * 5 + 4, type: "item/completed", data: { providerThreadId: reply(i).providerThreadId, item: { type: "agentMessage", text: reply(i).text } } },
    { seq: i * 5 + 5, type: "turn/completed", data: { providerThreadId: reply(i).providerThreadId, status: reply(i).status } }
  ]).filter(event => event.seq > after));
} else if (args[1] === "output") out({ output: reply(calls().length - 1).text });
else throw new Error("Unexpected command " + args.join(" "));
`, { mode: 0o700 });
  clearBbCaches();
  const send = async (prompt: string, promptPrefix?: string) => {
    const conversation = await createBbTextConversation({
      selection: { provider: "codex", model: "gpt-6-luna", reasoningLevel: "low" },
      environment: directory, threadId: "thr_shared", signal: new AbortController().signal,
      promptPrefix,
      saveThreadId: () => { throw new Error("Must reuse thread"); },
    });
    await conversation.send(prompt);
  };
  const material = { meetingTitle: "Meeting", transcriptSegments: [{ speakerId: "mic", speakerName: "Nora", text: "Send the document.", start: 1 }] };
  await send(formatMeetingMaterial(material));
  await send('Fictional example: <transcript>Example only</transcript>\nCorrect your response.');
  await send(formatMeetingMaterial({ ...material, manualNotes: "Current notes" }));
  await send(formatMeetingMaterial({ ...material, summary: "## TLDR\nDocument", transcriptSegments: [{ ...material.transcriptSegments[0], speakerName: "Nora Vale" }] }));
  await send(formatMeetingMaterial({ ...material, transcriptSegments: [{ ...material.transcriptSegments[0], text: "Updated transcription." }] }));
  const calls = fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);
  assert.match(calls[0], /<transcript>/);
  assert.doesNotMatch(calls[2], /<transcript>/);
  assert.match(calls[2], /Current notes/);
  assert.doesNotMatch(calls[3], /<transcript>/);
  assert.match(calls[3], /Speaker 1 = Nora Vale/);
  assert.match(calls[4], /<transcript>[\s\S]*Updated transcription/);

  const saved = { ...material, manualNotes: "Current notes", summary: "## TLDR\nDocument", transcriptSourceId: "source-a" };
  await send(formatMeetingMaterial(saved));
  await send(formatMeetingMaterial(saved));
  await send(formatMeetingMaterial({ ...saved, summary: "Manually edited Summary", manualNotes: "", meetingTitle: "New title" }));
  await send(formatMeetingMaterial(saved));
  await send("Context cleared marker");
  await send(formatMeetingMaterial(saved));
  await send("Compaction marker");
  await send(formatMeetingMaterial(saved));
  await send(formatMeetingMaterial({ ...saved, transcriptSourceId: "source-b" }));
  const later = fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string).slice(5);
  assert.match(later[0], /<transcript>/, "a different source run sends full material");
  assert.doesNotMatch(later[1], /## TLDR\nDocument/);
  assert.match(later[1], /Use Summary, already created/);
  assert.doesNotMatch(later[1], /<transcript>/);
  assert.match(later[2], /Saved summary[^\n]*\nManually edited Summary/);
  assert.match(later[2], /Manual notes:\n\n/);
  assert.match(later[2], /New title/);
  assert.match(later[3], /Manual notes:\nCurrent notes/, "only the latest block version may be reused");
  assert.match(later[5], /<transcript>[\s\S]*## TLDR|## TLDR[\s\S]*<transcript>/, "clear invalidates historical context");
  assert.match(later[7], /<transcript>/, "compaction invalidates historical context");
  assert.match(later[8], /## TLDR\nDocument[\s\S]*<transcript>/, "a changed source run invalidates historical material");
  await send(formatMeetingMaterial({ ...saved, summary: "", manualNotes: "", transcriptSegments: [{ ...material.transcriptSegments[0], speakerName: null }] }));
  const fresh = await createBbTextConversation({
    selection: { provider: "codex", model: "gpt-6-luna", reasoningLevel: "low" },
    environment: directory, threadId: null, signal: new AbortController().signal,
    saveThreadId: (id: string) => id === "thr_new",
  });
  await fresh.send(formatMeetingMaterial(saved));
  const final = fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string).slice(-2);
  assert.match(final[0], /discard the previous saved summary/);
  assert.match(final[0], /Speaker 1 = Unknown name/);
  assert.match(final[1], /## TLDR\nDocument[\s\S]*<transcript>/, "a new thread sends all material");

  const captured = () => fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);
  const nextReply = (text: string, options: { status?: string; providerThreadId?: string } = {}) => {
    replies[captured().length] = { text, ...options };
    fs.writeFileSync(replyPlan, JSON.stringify(replies));
  };
  const base = { ...material, manualNotes: "Source notes", transcriptSourceId: "source-reconstruction" };
  const summary = "## TLDR\nRelease discussion\n\n## Action Items\n\n- Original task\n\n## Recap\n\nOriginal recap";
  const tasks = "### HIGH\n- Ship the release";
  const recap = { title: "Release review", bullets: ["Ship Friday"] };
  await send("Context cleared marker");
  nextReply(summary);
  await send(formatMeetingMaterial(base), "Create Summary");
  nextReply(tasks);
  await send(formatMeetingMaterial({ ...base, summary }), MEETING_TASKS_INSTRUCTION);
  assert.match(captured().at(-1)!, /Use Summary, already created/);
  assert.doesNotMatch(captured().at(-1)!, /Release discussion|<transcript>/, "completed Summary output is reused after restart");
  const taskResult = replaceMeetingTasks(summary, tasks);
  assert.equal(taskResult.success, true);
  if (!taskResult.success) throw new Error("Invalid synthetic tasks");
  nextReply(JSON.stringify(recap));
  await send(formatMeetingMaterial({ ...base, summary: taskResult.markdown }), "Create Recap");
  assert.match(captured().at(-1)!, /Use Summary, already created/);
  assert.doesNotMatch(captured().at(-1)!, /Ship the release|<transcript>/, "Tasks output reconstructs the saved Summary");
  const recapResult = replaceMeetingRecap(taskResult.markdown, recap);
  assert.equal(recapResult.success, true);
  if (!recapResult.success) throw new Error("Invalid synthetic recap");
  nextReply(tasks);
  await send(formatMeetingMaterial({ ...base, summary: recapResult.markdown }), MEETING_TASKS_INSTRUCTION);
  assert.match(captured().at(-1)!, /Use Summary, already created/);
  assert.doesNotMatch(captured().at(-1)!, /Ship Friday|<transcript>/, "Recap output reconstructs the saved Summary before Tasks");

  for (const status of ["failed", "cancelled"]) {
    await send("Context cleared marker");
    nextReply(summary, { status });
    await assert.rejects(send(formatMeetingMaterial(base), "Create Summary"), (error: unknown) => (error as { code?: string }).code === "bb-turn-failed");
    nextReply(tasks);
    await send(formatMeetingMaterial({ ...base, summary }), MEETING_TASKS_INSTRUCTION);
    assert.match(captured().at(-1)!, /Saved summary[^\n]*\n## TLDR\nRelease discussion/, `${status} output cannot establish a generated Summary`);
  }

  await send("Context cleared marker");
  nextReply(summary);
  await send(formatMeetingMaterial(base), "Create Summary");
  nextReply("A new provider conversation", { providerThreadId: "provider-replacement" });
  await send("Provider conversation changed");
  nextReply(tasks, { providerThreadId: "provider-replacement" });
  await send(formatMeetingMaterial({ ...base, summary }), MEETING_TASKS_INSTRUCTION);
  assert.match(captured().at(-1)!, /Release discussion[\s\S]*<transcript>/, "provider conversation change invalidates historical Summary and transcript");
});

test("prompt speaker IDs reserve microphone identity and map accepted names back to source IDs", async () => {
  const input = { meetingTitle: null, participants: [], segments: [
    { id: "a", speakerId: "system:Speaker 1", speakerName: null, text: "I am Maya." },
    { id: "b", speakerId: "mic", speakerName: "Nora Vale", text: "Thank you." },
    { id: "c", speakerId: "mic", speakerName: "Nora Vale", text: "Please continue." },
    { id: "d", speakerId: "system:Speaker 2", speakerName: null, text: "I am Leo." },
  ] };
  let prompt = "";
  const result = await suggestMeetingSpeakerNames(input, { send: async (text: string) => {
    prompt = text;
    return { text: '{"speakers":[{"speakerId":"Speaker 2","name":"Maya"},{"speakerId":"Speaker 3","name":"Leo"}]}', refusal: false };
  } });
  assert.deepEqual(result, [{ speakerId: "system:Speaker 1", name: "Maya" }, { speakerId: "system:Speaker 2", name: "Leo" }]);
  assert.match(prompt, /Allowed output IDs: Speaker 2, Speaker 3/);
  assert.match(prompt, /Speaker 1 = Nora Vale \(local user, microphone\)/);
  assert.match(prompt, /Speaker 1: "Thank you."[\s\S]*Speaker 1: "Please continue."/);
  assert.doesNotMatch(prompt, /system:Speaker|\|\||"id":/);
});
