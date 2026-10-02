import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAudioPipeline, flushAndDisconnectProcessor, setAudioPipelineGate } from "../../../../src/helpers/meetingAudioPipeline.ts";
import { installBrowserGlobals } from "../../../lib/rendererTestHarness.ts";

type Options = Parameters<typeof createAudioPipeline>[0];
type Send = NonNullable<typeof window.electronAPI.meetingTranscriptionSend>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t: TestContext, send: Send) {
  const messages: Array<Record<string, unknown>> = [];
  const boundaries: Array<Parameters<Options["onMicrophoneBoundary"]>[0]> = [];
  const acks: number[] = [];
  const failures: Error[] = [];
  class Processor {
    disconnected = false;
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: Record<string, unknown>) => { messages.push(message); },
    };
    connect() {}
    disconnect() { this.disconnected = true; }
    receive(data: unknown) { this.port.onmessage?.({ data }); }
  }
  let processor!: Processor;
  let pipeline: Awaited<ReturnType<typeof createAudioPipeline>> | undefined;
  t.after(async () => {
    if (pipeline && !processor.disconnected) {
      const stopped = flushAndDisconnectProcessor(pipeline.processor);
      processor.receive({ type: "error", code: "test-cleanup" });
      await stopped.catch(() => {});
    }
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "AudioWorkletNode", original);
    else delete (globalThis as Record<string, unknown>).AudioWorkletNode;
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: class extends Processor {
    constructor() { super(); processor = this; }
  } });
  installBrowserGlobals(t, { window: { electronAPI: { meetingTranscriptionSend: send } } });
  const node = { connect() {}, disconnect() {} };
  const context = { state: "running", audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => node, createGain: () => ({ ...node, gain: { value: 0 } }), destination: node,
  } as unknown as Options["context"];
  pipeline = await createAudioPipeline({
    stream: {} as Options["stream"], context, source: "mic", sessionId: "session",
    epochIndex: 2, renderOriginFrame: 4800, sourceGeneration: 3,
    reserveEpoch: () => 3,
    onMicrophoneBoundary: boundary => boundaries.push(boundary),
    onAck: sequence => acks.push(sequence), onFailure: error => failures.push(error),
  });
  const chunk = (sequence = 0, epochIndex = 2) => processor.receive({ type: "chunk",
    buffer: new ArrayBuffer(4800), sequence, sampleOffset: 0, renderStartFrame: 9600,
    epochIndex, sourceGeneration: 3,
  });
  return { pipeline, processor, messages, boundaries, acks, failures, chunk };
}

test("pipeline drain waits for the final write ACK and reports the mic source boundary", async t => {
  const pending = deferred<Awaited<ReturnType<Send>>>();
  t.after(() => pending.resolve({ success: true, sequence: 0 }));
  const packets: Parameters<Send>[3][] = [];
  const h = await setup(t, async (_buffer, source, session, packet) => {
    assert.equal(source, "mic");
    assert.equal(session, "session");
    packets.push(packet);
    return pending.promise;
  });
  h.chunk();
  let finished = false;
  const stopping = flushAndDisconnectProcessor(h.pipeline.processor).then(value => { finished = true; return value; });
  h.processor.receive({ type: "flush-complete", lastSequence: 0, boundaryRenderFrame: 12000 });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  assert.equal(h.processor.disconnected, false);
  assert.equal(packets[0]?.sourceFrameStart, 4800);
  assert.equal(packets[0]?.epochIndex, 2);
  assert.equal(packets[0]?.sourceGeneration, 3);
  assert.deepEqual(h.boundaries, [{ sourceGeneration: 3, sourceFrame: 7200, alignment: null }]);
  pending.resolve({ success: true, sequence: 0 });
  assert.equal(await stopping, 0);
  assert.deepEqual(h.acks, [0]);
  assert.equal(h.processor.port.onmessage, null);
  assert.equal(h.processor.disconnected, true);
  assert.deepEqual(h.failures, []);
});

test("pipeline gate holds unmuted packets until the persisted intent commits", async t => {
  const sent: number[] = [];
  const h = await setup(t, async (_buffer, _source, _session, packet) => {
    sent.push(packet?.epochIndex ?? -1);
    return { success: true, sequence: packet?.sequence };
  });
  h.chunk();
  await new Promise(setImmediate);
  const transition = async (muted: boolean, sequence: number) => {
    const pending = setAudioPipelineGate(h.pipeline.processor, muted, sequence);
    const request = h.messages.at(-1)!;
    h.processor.receive({ ...request, type: "gate-ack", boundaryRenderFrame: 12000, lastSequence: 0 });
    return pending;
  };
  (await transition(true, 1)).commit();
  const opening = await transition(false, 2);
  assert.equal(opening.ack.boundaryFrame, 7200);
  assert.equal(opening.ack.sourceGeneration, 3);
  h.chunk(0, 3);
  await new Promise(setImmediate);
  assert.deepEqual(sent, [2]);
  opening.commit();
  await new Promise(setImmediate);
  assert.deepEqual(sent, [2, 3]);
  const stopping = flushAndDisconnectProcessor(h.pipeline.processor);
  h.processor.receive({ type: "flush-complete", lastSequence: 0, boundaryRenderFrame: 12000 });
  assert.equal(await stopping, 0);
});

test("pipeline drain propagates a worklet failure and disconnects the processor", async t => {
  const h = await setup(t, async () => ({ success: true, sequence: 0 }));
  const stopping = flushAndDisconnectProcessor(h.pipeline.processor);
  h.processor.receive({ type: "error", code: "mic-input-gap" });
  await assert.rejects(stopping, /mic-input-gap/);
  assert.equal(h.processor.port.onmessage, null);
  assert.equal(h.processor.disconnected, true);
  assert.deepEqual(h.failures.map(error => error.message), ["mic-input-gap"]);
});
