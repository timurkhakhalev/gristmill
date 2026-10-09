import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// Replay ACK latency through the actual AudioWorklet without waiting for wall time.
// This models a serial writer; it does not emulate the OS audio device or encoder.
function replay(writeMs: number, seconds: number) {
  const source = fs.readFileSync(path.join(__dirname, "../../../../src/helpers/meetingAudioPipeline.ts"), "utf8");
  const template = source.match(/const code = `([\s\S]*?)`;/)?.[1];
  assert.ok(template);
  const code = template.replaceAll("${MEETING_AUDIO_BUFFER_SIZE}", "2400")
    .replaceAll("${MAX_UNACKNOWLEDGED_CAPTURE_FRAMES}", "120000")
    .replaceAll("${MAX_CAPTURE_ACK_AGE_MS}", "10000");
  type Message = { type: string; sequence?: number; epochIndex?: number; code?: string };
  type Processor = { port: { onmessage: (event: { data: Message }) => void }; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
  let Constructor!: new (options: object) => Processor;
  let frame = 0;
  let writerFreeAt = 0;
  let packets = 0;
  let failure: string | undefined;
  const pending: Array<{ at: number; message: Message }> = [];
  vm.runInNewContext(code, {
    get currentFrame() { return frame; },
    registerProcessor: (_name: string, value: typeof Constructor) => { Constructor = value; },
    AudioWorkletProcessor: class {
      port = { onmessage: () => {}, postMessage(message: Message) {
        if (message.type === "error") failure = message.code;
        if (message.type !== "chunk") return;
        packets++;
        writerFreeAt = Math.max(writerFreeAt, frame / 24) + writeMs;
        pending.push({ at: writerFreeAt, message: { ...message, type: "ack" } });
      } };
    },
  });
  const processor = new Constructor({ processorOptions: { epochIndex: 0, sourceGeneration: 1 } });
  const input = new Float32Array(128);
  const output = new Float32Array(128);
  for (; frame < seconds * 24000; frame += 128) {
    while (pending[0]?.at <= frame / 24) processor.port.onmessage({ data: pending.shift()!.message });
    if (!processor.process([[input]], [[output]])) break;
  }
  return { failure, seconds: frame / 24000, packets };
}

test("150ms serial writes overflow the real worklet; 1ms writes sustain two virtual minutes", () => {
  const overloaded = replay(150, 120);
  assert.equal(overloaded.failure, "capture-queue-overflow");
  assert.ok(overloaded.seconds > 14 && overloaded.seconds < 16);
  const optimized = replay(1, 120);
  assert.equal(optimized.failure, undefined);
  assert.equal(optimized.seconds, 120);
  assert.equal(optimized.packets, 1200);
  console.log("CAPTURE_BACKPRESSURE", JSON.stringify({ overloaded, optimized }));
});
