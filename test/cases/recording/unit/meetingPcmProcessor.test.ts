const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const vm: typeof import("node:vm") = require("node:vm");

test("microphone gate counts muted render frames without sending, then sends at the real unmute frame", () => {
  const store = fs.readFileSync(path.join(__dirname, "../../../../src/stores/meetingRecordingStore.ts"), "utf8");
  const worklet = store.match(/const code = `([\s\S]*?)`;/)?.[1]
    .replace("${MEETING_AUDIO_BUFFER_SIZE}", "2400")
    .replace("${MAX_UNACKNOWLEDGED_CAPTURE_FRAMES}", "120000")
    .replace("${MAX_CAPTURE_ACK_AGE_MS}", "10000");
  assert.ok(worklet);

  type Port = { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: unknown): void };
  type Processor = new (options: { processorOptions: { gateClosed: boolean; epochIndex: number; sourceGeneration: number } }) => {
    port: Port;
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  };
  const sent: Array<Record<string, any>> = [];
  const registered: { processor?: Processor } = {};
  let currentFrame = 0;
  vm.runInNewContext(worklet, {
    AudioWorkletProcessor: class {
      port: Port = { onmessage: null, postMessage: (message) => sent.push(message as typeof sent[number]) };
    },
    get currentFrame() { return currentFrame; },
    registerProcessor: (_name: string, processor: Processor) => { registered.processor = processor; },
  });
  assert.ok(registered.processor);
  const processor = new registered.processor({ processorOptions: { gateClosed: false, epochIndex: 0, sourceGeneration: 1 } });
  const chunks = () => sent.filter((message) => message.type === "chunk");
  const loud = new Float32Array(2400).fill(0.5);
  const audibleOutput = new Float32Array(2400);
  assert.equal(processor.process([[loud]], [[audibleOutput]]), true);
  assert.equal(sent[0].type, "chunk");
  assert.equal(sent[0].renderStartFrame, 0);
  assert.equal(sent[0].sourceGeneration, 1);
  assert.equal(audibleOutput[0], 0.5);
  processor.port.onmessage?.({ data: { type: "ack", sequence: 0 } });

  currentFrame = 2400;
  processor.port.onmessage?.({ data: { type: "set-gate", commandId: "mute-1", sequence: 1, effectiveMuted: true, epochIndex: 0, sourceGeneration: 1 } });
  const muteAck = sent.at(-1)!;
  assert.equal(muteAck.type, "gate-ack");
  assert.equal(muteAck.commandId, "mute-1");
  assert.equal(muteAck.effectiveMuted, true);
  assert.equal(muteAck.boundaryRenderFrame, 2400);
  assert.equal(muteAck.lastSequence, 0);
  currentFrame = 7200;
  const mutedOutput = new Float32Array(2400).fill(1);
  assert.equal(processor.process([[loud]], [[mutedOutput]]), true);
  assert.equal(mutedOutput.every((sample) => sample === 0), true);
  assert.equal(chunks().length, 1);

  currentFrame = 9600;
  processor.port.onmessage?.({ data: { type: "set-gate", commandId: "unmute-2", sequence: 2, effectiveMuted: false, epochIndex: 1, sourceGeneration: 2 } });
  const unmuteAck = sent.at(-1)!;
  assert.equal(unmuteAck.type, "gate-ack");
  assert.equal(unmuteAck.commandId, "unmute-2");
  assert.equal(unmuteAck.sourceGeneration, 2);
  assert.equal(unmuteAck.effectiveMuted, false);
  assert.equal(unmuteAck.boundaryRenderFrame, 9600);
  assert.equal(unmuteAck.lastSequence, -1);
  const resumedOutput = new Float32Array(2400);
  assert.equal(processor.process([[loud]], [[resumedOutput]]), true);
  assert.equal(chunks().length, 2);
  assert.equal(chunks()[1].renderStartFrame, 9600);
  assert.equal(chunks()[1].epochIndex, 1);
  assert.equal(chunks()[1].sourceGeneration, 2);
  assert.equal(chunks()[1].sampleOffset, 0);
  assert.equal(resumedOutput[0], 0.5);

  currentFrame = 12000;
  assert.equal(processor.process([[new Float32Array([0.25])]], [[new Float32Array(1)]]), true);
  processor.port.onmessage?.({ data: { type: "flush" } });

  assert.deepEqual(sent.slice(-2).map(({ type }) => type), ["chunk", "flush-complete"]);
  const tail = sent.at(-2)!;
  const flushed = sent.at(-1)!;
  assert.equal(tail.renderStartFrame, 12000);
  assert.equal(tail.epochIndex, 1);
  assert.equal(tail.sourceGeneration, 2);
  assert.equal(tail.sequence, 1);
  assert.equal(tail.sampleOffset, 2400);
  assert.equal(tail.buffer.byteLength, 2);
  assert.equal(flushed.lastSequence, 1);
  assert.equal(processor.process([[]], [[]]), false);
});
