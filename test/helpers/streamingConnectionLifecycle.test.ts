const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const AssemblyAiStreaming: typeof import("../../src/helpers/assemblyAiStreaming.ts") = require("../../src/helpers/assemblyAiStreaming.ts");
const CortiStreaming: typeof import("../../src/helpers/cortiStreaming.ts") = require("../../src/helpers/cortiStreaming.ts");
const DeepgramStreaming: typeof import("../../src/helpers/deepgramStreaming.ts") = require("../../src/helpers/deepgramStreaming.ts");
const OpenAIRealtimeStreaming = require("../../src/helpers/openaiRealtimeStreaming.ts");

const clients = [
  ["OpenAI", OpenAIRealtimeStreaming, "_notifyConnectionLost"],
  ["AssemblyAI", AssemblyAiStreaming, "notifyConnectionLost"],
  ["Deepgram", DeepgramStreaming, "notifyConnectionLost"],
  ["Corti", CortiStreaming, "notifyConnectionLost"],
];

for (const [name, StreamingClient, notifyMethod] of clients) {
  test(`${name} reports one recoverable connection loss to meetings`, () => {
    const streaming = new StreamingClient();
    const recoveries: unknown[] = [];
    const errors: unknown[] = [];
    streaming.onConnectionLost = (error: any) => recoveries.push(error.message);
    streaming.onError = (error: any) => errors.push(error.message);

    streaming[notifyMethod](new Error("socket failed"));
    streaming[notifyMethod](new Error("duplicate close"));

    assert.deepEqual(recoveries, ["socket failed"]);
    assert.deepEqual(errors, []);
  });

  test(`${name} preserves the existing error path outside meetings`, () => {
    const streaming = new StreamingClient();
    const errors: unknown[] = [];
    streaming.onError = (error: any) => errors.push(error.message);

    streaming[notifyMethod](new Error("socket failed"));

    assert.deepEqual(errors, ["socket failed"]);
  });
}
