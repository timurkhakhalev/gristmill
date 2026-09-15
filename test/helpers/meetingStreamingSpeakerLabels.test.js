const test = require("node:test");
const assert = require("node:assert/strict");

const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming.ts");
const CortiStreaming = require("../../src/helpers/cortiStreaming.ts");
const DeepgramStreaming = require("../../src/helpers/deepgramStreaming.ts");
const OpenAIRealtimeStreaming = require("../../src/helpers/openaiRealtimeStreaming.ts");

const message = (value) => Buffer.from(JSON.stringify(value));

test("provider finals keep the timestamps used by live meeting speaker labels", () => {
  const finals = [];

  const openai = new OpenAIRealtimeStreaming();
  openai.speechStartedAt = 1_000;
  openai.onFinalTranscript = (text, startedAt) => finals.push(["openai", text, startedAt]);
  openai.handleMessage(
    message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "OpenAI final",
    })
  );

  const assembly = new AssemblyAiStreaming();
  assembly.speechStartedAt = 2_000;
  assembly.onFinalTranscript = (text, startedAt) => finals.push(["assembly", text, startedAt]);
  assembly.handleMessage(
    message({ type: "Turn", transcript: "Assembly final", end_of_turn: true })
  );

  const deepgram = new DeepgramStreaming();
  deepgram.sessionStartedAt = 3_000;
  deepgram.onFinalTranscript = (text, startedAt) => finals.push(["deepgram", text, startedAt]);
  deepgram.handleMessage(
    message({
      type: "Results",
      is_final: true,
      start: 0.25,
      channel: { alternatives: [{ transcript: "Deepgram final" }] },
    })
  );

  const corti = new CortiStreaming();
  corti.sessionStartedAt = 4_000;
  corti.onFinalTranscript = (text, startedAt) => finals.push(["corti", text, startedAt]);
  corti.handleMessage(
    message({
      type: "transcript",
      data: { text: "Corti final", isFinal: true, start: 0.5 },
    })
  );

  assert.deepEqual(finals, [
    ["openai", "OpenAI final", 1_000],
    ["assembly", "Assembly final", 2_000],
    ["deepgram", "Deepgram final", 3_250],
    ["corti", "Corti final", 4_500],
  ]);
});
