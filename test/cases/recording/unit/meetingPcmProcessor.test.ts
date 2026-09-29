const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const vm: typeof import("node:vm") = require("node:vm");

test("microphone flush writes its final partial packet without another audio callback", () => {
  const store = fs.readFileSync(path.join(__dirname, "../../../../src/stores/meetingRecordingStore.ts"), "utf8");
  const worklet = store.match(/const code = `([\s\S]*?)`;/)?.[1]
    .replace("${MEETING_AUDIO_BUFFER_SIZE}", "2400")
    .replace("${MAX_UNACKNOWLEDGED_CAPTURE_FRAMES}", "120000")
    .replace("${MAX_CAPTURE_ACK_AGE_MS}", "10000");
  assert.ok(worklet);

  type Port = { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: unknown): void };
  type Processor = new () => { port: Port; process(inputs: Float32Array[][]): boolean };
  const sent: Array<{ type: string; buffer?: ArrayBuffer; lastSequence?: number }> = [];
  const registered: { processor?: Processor } = {};
  vm.runInNewContext(worklet, {
    AudioWorkletProcessor: class {
      port: Port = { onmessage: null, postMessage: (message) => sent.push(message as typeof sent[number]) };
    },
    currentFrame: 0,
    registerProcessor: (_name: string, processor: Processor) => { registered.processor = processor; },
  });
  assert.ok(registered.processor);
  const processor = new registered.processor();
  assert.equal(processor.process([[new Float32Array([0.5])]]), true);
  processor.port.onmessage?.({ data: { type: "flush" } });

  assert.deepEqual(sent.map(({ type }) => type), ["chunk", "flush-complete"]);
  assert.equal(sent[0].buffer?.byteLength, 2);
  assert.equal(sent[1].lastSequence, 0);
  assert.equal(processor.process([[]]), false);
});
