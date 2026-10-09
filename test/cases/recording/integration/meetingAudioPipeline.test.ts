import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createAudioPipeline,
  flushAndDisconnectProcessor,
  setAudioPipelineGate,
} from "../../../../src/helpers/meetingAudioPipeline.ts";
import { installBrowserGlobals } from "../../../lib/rendererTestHarness.ts";

type Options = Parameters<typeof createAudioPipeline>[0];

type Send = NonNullable<typeof window.electronAPI.meetingTranscriptionSend>;

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((done) => {
    resolve = done;
  });

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
      postMessage: (message: Record<string, unknown>) => {
        messages.push(message);
      },
    };
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
    receive(data: unknown) {
      this.port.onmessage?.({ data });
    }
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
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: class extends Processor {
      constructor() {
        super();
        processor = this;
      }
    },
  });
  installBrowserGlobals(t, { window: { electronAPI: { meetingTranscriptionSend: send } } });
  const node = { connect() {}, disconnect() {} };

  const context = {
    state: "running",
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => node,
    createGain: () => ({ ...node, gain: { value: 0 } }),
    destination: node,
  } as unknown as Options["context"];

  pipeline = await createAudioPipeline({
    stream: {} as Options["stream"],
    context,
    source: "mic",
    sessionId: "session",
    epochIndex: 2,
    renderOriginFrame: 4800,
    sourceGeneration: 3,
    reserveEpoch: () => 3,
    onMicrophoneBoundary: (boundary) => boundaries.push(boundary),
    onAck: (sequence) => acks.push(sequence),
    onFailure: (error) => failures.push(error),
  });

  const chunk = (sequence = 0, epochIndex = 2) =>
    processor.receive({
      type: "chunk",
      buffer: new ArrayBuffer(4800),
      sequence,
      sampleOffset: 0,
      renderStartFrame: 9600,
      epochIndex,
      sourceGeneration: 3,
    });

  return { pipeline, processor, messages, boundaries, acks, failures, chunk };
}

test("pipeline drain waits for the final write ACK and reports the mic source boundary", async (t) => {
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

  const stopping = flushAndDisconnectProcessor(h.pipeline.processor).then((value) => {
    finished = true;

    return value;
  });

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

test("pipeline gate holds unmuted packets until the persisted intent commits", async (t) => {
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
    h.processor.receive({
      ...request,
      type: "gate-ack",
      boundaryRenderFrame: 12000,
      lastSequence: 0,
    });

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

test("pipeline drain propagates a worklet failure and disconnects the processor", async (t) => {
  const h = await setup(t, async () => ({ success: true, sequence: 0 }));
  const stopping = flushAndDisconnectProcessor(h.pipeline.processor);
  h.processor.receive({ type: "error", code: "mic-input-gap" });
  await assert.rejects(stopping, /mic-input-gap/);
  assert.equal(h.processor.port.onmessage, null);
  assert.equal(h.processor.disconnected, true);
  assert.deepEqual(
    h.failures.map((error) => error.message),
    ["mic-input-gap"]
  );
});

test("a render gap preserves serial writes and epoch-qualified ACKs", async (t) => {
  const pending = deferred<Awaited<ReturnType<Send>>>();
  t.after(() => pending.resolve({ success: true, sequence: 0 }));
  const epochs: number[] = [];
  const h = await setup(t, async (_buffer, _source, _session, packet) => {
    epochs.push(packet!.epochIndex);
    return epochs.length === 1 ? pending.promise : { success: true, sequence: 0 };
  });
  h.chunk();
  h.processor.receive({ type: "source-gap", epochIndex: 3 });
  h.chunk(0, 3);
  await new Promise(setImmediate);
  assert.deepEqual(epochs, [2], "the new epoch must wait for the old epoch's write");
  pending.resolve({ success: true, sequence: 0 });
  await new Promise(setImmediate);
  assert.deepEqual(epochs, [2, 3]);
  assert.deepEqual(h.messages.filter((message) => message.type === "ack"), [
    { type: "ack", sequence: 0, epochIndex: 2 },
    { type: "ack", sequence: 0, epochIndex: 3 },
  ]);
  assert.deepEqual(h.failures, []);
  const stopping = flushAndDisconnectProcessor(h.pipeline.processor);
  h.processor.receive({ type: "flush-complete", lastSequence: 0, boundaryRenderFrame: 12000 });
  assert.equal(await stopping, 0);
});

// These fixtures exercise the post-Stop boundary with the existing persisted recording harness.
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const { randomUUID, createHash }: typeof import("node:crypto") = require("node:crypto");
const { spawn, spawnSync }: typeof import("node:child_process") = require("node:child_process");
const { EventEmitter }: typeof import("node:events") = require("node:events");
const { createDb }: typeof import("../../../helpers/harness/db.ts") = require("../../../helpers/harness/db.ts");
const { getUserDataDir }: typeof import("../../../helpers/harness/electronStub.ts") = require("../../../helpers/harness/electronStub.ts");
const { savePcmEpoch }: typeof import("../../../lib/meetingAudioFixture.ts") = require("../../../lib/meetingAudioFixture.ts");
const { MeetingRecordingStorage }: typeof import("../../../../src/helpers/meetingRecordingStorage.ts") = require("../../../../src/helpers/meetingRecordingStorage.ts");
const { prepareMeetingAudio }: typeof import("../../../../src/helpers/meetingAudioMixer.ts") = require("../../../../src/helpers/meetingAudioMixer.ts");

type MixerDeps = import("../../../../src/helpers/meetingAudioMixer.ts").MeetingAudioMixerDeps;
const ffmpeg: string = require("ffmpeg-static");
const helper = path.resolve("resources/bin/meeting-resampler");

function postStopFixture(t: TestContext, overlap = false) {
  const db = createDb(t);
  assert.ok(db);
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Synthetic preparation", "Keep manual content", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config: null }, "2026-10-01T10:00:00.000Z");
  const specs: Array<{ source: "mic" | "system"; index: number; start: number; frames: number; hz: number; amplitude: number }> = [
    { source: "mic", index: 0, start: 0, frames: 48000, hz: 220, amplitude: 8000 },
    { source: "system", index: 0, start: 8000, frames: 48000, hz: 440, amplitude: 6000 },
  ];
  if (overlap) specs.push({ source: "mic", index: 1, start: 24000, frames: 24000, hz: 330, amplitude: 5000 });
  for (const spec of specs) {
    db.createMeetingRecordingEpoch(recording.id, spec.source, spec.index, spec.index + 1, 0, spec.start);
    const pcm = Buffer.alloc(spec.frames * 2);
    for (let i = 0; i < spec.frames; i++) pcm.writeInt16LE(Math.round(spec.amplitude * Math.sin(2 * Math.PI * spec.hz * i / 24000)), i * 2);
    savePcmEpoch(storage, recording.id, spec.source, spec.index, pcm);
    db.updateMeetingRecordingEpochRecovery(recording.id, spec.source, spec.index, storage.recoverEpoch(recording.id, spec.source, spec.index));
  }
  db.markMeetingRecordingFinalizing(recording.id);
  const finalized = db.finalizeMeetingRecording(recording.id, { captureState: "ready", endedAt: "2026-10-01T10:00:04.000Z", sourceMetadata: { captureEndFrame: 96000 } });
  const epochs = db.listMeetingRecordingEpochs(recording.id);
  const originals = epochs.map(epoch => storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex));
  const hashes = originals.map(file => createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  storage.writeRunArtifact(finalized.initialRun.id, "provider-response", { durable: "prior completed response" });
  const protectedResponse = fs.readFileSync(path.join(storage.resultsRoot, finalized.initialRun.id, "raw-provider-response.json"));
  const assertPreserved = () => {
    assert.deepEqual(originals.map(file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")), hashes);
    assert.deepEqual(fs.readFileSync(path.join(storage.resultsRoot, finalized.initialRun.id, "raw-provider-response.json")), protectedResponse);
    assert.equal(db.getNote(note.id)!.content, "Keep manual content");
  };
  return { db, storage, note, recording: finalized.recording, epochs, originals, specs, assertPreserved,
    derived: path.dirname(storage.getDerivedAudioPath(recording.id, randomUUID())) };
}
function assertNoWorkingFiles(f: ReturnType<typeof postStopFixture>) {
  assert.ok(fs.readdirSync(f.derived).every(name => !name.startsWith(".tmp-")));
}
function wavSamples(file: string) {
  const wav = fs.readFileSync(file), data = wav.indexOf(Buffer.from("data"));
  assert.ok(data > 0);
  return wav.subarray(data + 8, data + 8 + wav.readUInt32LE(data + 4));
}
function nativeDeps(): MixerDeps { return { ffmpegPath: () => ffmpeg, resamplerPath: () => helper }; }

class HeldPreparationChild extends EventEmitter {
  stderr = new EventEmitter();
  killed = false;
  closed = false;
  kill() { this.killed = true; return true; }
  close(code: number | null = 0) {
    if (this.closed) return;
    this.closed = true; this.emit("close", code);
  }
  asProcess() { return this as unknown as import("node:child_process").ChildProcess; }
}
function controlledChildren(t: TestContext, cancel?: () => void) {
  const children: HeldPreparationChild[] = [];
  let owned: Promise<unknown> | undefined;
  t.after(async () => { cancel?.(); children.forEach(child => child.close(null)); await owned?.catch(() => {}); });
  return {
    children,
    child() { const child = new HeldPreparationChild(); children.push(child); return child; },
    own(promise: Promise<unknown>) { owned = promise; promise.catch(() => {}); },
  };
}

test("persisted Opus uses native correction in all layouts, with independent overlap and channel oracles", async t => {
  const f = postStopFixture(t, true);
  const decoded = f.epochs.map(epoch => {
    const file = f.storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex);
    const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-ar", "24000", "-ac", "1", "-f", "f32le", "pipe:1"]);
    assert.equal(result.status, 0, result.stderr.toString());
    const buffer = result.stdout;
    assert.equal(buffer.length, epoch.frameCount * 4);
    return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  });
  for (const layout of ["mono", "stereo", "mic", "system"] as const) {
    const commands: Array<{ command: string; args: string[] }> = [];
    let activeDecoders = 0, maximumDecoders = 0;
    const runId = randomUUID();
    const prepared = await prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { layout, deps: { ...nativeDeps(), spawn: (command, args, options) => {
      commands.push({ command, args });
      const decoding = args.includes("pcm_f32le");
      if (args.includes("-filter_complex")) assert.equal(activeDecoders, 0);
      if (decoding) { activeDecoders++; maximumDecoders = Math.max(maximumDecoders, activeDecoders); }
      const child = spawn(command, args, options);
      if (decoding) child.once("close", () => activeDecoders--);
      return child;
    } } });
    const chosen = f.epochs.filter(epoch => layout !== "mic" && layout !== "system" || epoch.source === layout);
    assert.equal(commands.filter(command => command.args.includes("pcm_f32le")).length, chosen.length);
    assert.ok(maximumDecoders <= 2); assert.equal(activeDecoders, 0);
    for (const source of ["mic", "system"] as const) {
      assert.deepEqual(commands.filter(command => command.args.includes("pcm_f32le") && command.args[command.args.indexOf("-i") + 1].includes(`/${source}/`)).map(command => command.args[command.args.indexOf("-i") + 1]),
        chosen.filter(epoch => epoch.source === source).map(epoch => f.storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex)));
    }
    assert.equal(commands.filter(command => command.command === helper).length, chosen.length);
    const data = wavSamples(prepared.path), channels = layout === "stereo" ? 2 : 1;
    assert.equal(data.length, 96000 * 2 * channels);
    for (let frame = 25000; frame < 47000; frame += 101) {
      const expected = { mic: 0, system: 0 };
      for (const [index, epoch] of f.epochs.entries()) {
        const sourceFrame = frame - epoch.timelineStartFrame!;
        if (sourceFrame >= 0 && sourceFrame < decoded[index].length) expected[epoch.source] += decoded[index][sourceFrame];
      }
      const values = layout === "stereo" ? [expected.mic, expected.system] : [layout === "mono" ? (expected.mic + expected.system) * 0.5 : expected[layout]];
      for (const [channel, value] of values.entries()) assert.ok(Math.abs(data.readInt16LE((frame * channels + channel) * 2) - Math.round(value * 32768)) <= 2, `${layout} independently expected contribution at ${frame}/${channel}`);
    }
    assert.ok(data.subarray(60000 * 2 * channels).every(value => value === 0));
    if (layout === "system") assert.ok(data.subarray(0, 8000 * 2).every(value => value === 0));
    assertNoWorkingFiles(f); f.assertPreserved();
    const cached = await prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { layout, deps: { ...nativeDeps(), resamplerPath: () => null, spawn: () => { throw new Error("cached final must not start work"); } } });
    assert.equal(cached.path, prepared.path);
  }
});

test("admission accounts for both float timelines, concurrent decoded epochs, mappings and final WAV", async t => {
  const f = postStopFixture(t), runId = randomUUID();
  let spawns = 0;
  // Old output-only admission fits here; actual peak intermediates do not.
  await assert.rejects(prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { deps: { ...nativeDeps(), availableBytes: () => 96000 * 2 + 4096, spawn: () => { spawns++; throw new Error("must not start"); } } }), { code: "audio-preparation-disk-full" });
  assert.equal(spawns, 0); assertNoWorkingFiles(f); f.assertPreserved();
});

test("pre-abort starts no child and publishes no final", async t => {
  const f = postStopFixture(t), controller = new AbortController(), runId = randomUUID();
  controller.abort(); let spawns = 0;
  await assert.rejects(prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { signal: controller.signal, deps: { ...nativeDeps(), spawn: () => { spawns++; throw new Error("must not start"); } } }), { name: "AbortError" });
  assert.equal(spawns, 0); assert.equal(fs.existsSync(f.storage.getDerivedAudioPath(f.recording.id, runId)), false); assertNoWorkingFiles(f);
});

test("mid-decode abort kills both owned children and waits for close before cleanup", async t => {
  const controller = new AbortController(), h = controlledChildren(t, () => controller.abort()), f = postStopFixture(t);
  const started = deferred<void>(), runId = randomUUID();
  const pending = prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { signal: controller.signal, deps: { ...nativeDeps(), spawn: (_command, args, options) => {
    assert.equal(options.detached, true);
    const child = h.child(); fs.writeFileSync(args.at(-1)!, Buffer.alloc(40));
    if (h.children.length === 2) started.resolve(); return child.asProcess();
  } } }); h.own(pending);
  await started.promise; let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(); await new Promise(setImmediate);
  assert.ok(h.children.every(child => child.killed)); assert.equal(settled, false);
  assert.ok(fs.readdirSync(f.derived).some(name => name.startsWith(".tmp-")));
  h.children[0].close(null); await new Promise(setImmediate); assert.equal(settled, false);
  h.children[1].close(null); await assert.rejects(pending, { name: "AbortError" });
  assertNoWorkingFiles(f); f.assertPreserved();
});

test("one decoder failure stops its peer and does not settle before peer close", async t => {
  const h = controlledChildren(t), f = postStopFixture(t), started = deferred<void>();
  const pending = prepareMeetingAudio(f.storage, f.recording, randomUUID(), f.epochs, { deps: { ...nativeDeps(), spawn: (_command, args) => {
    const child = h.child(); fs.writeFileSync(args.at(-1)!, Buffer.alloc(12));
    if (h.children.length === 2) started.resolve(); return child.asProcess();
  } } }); h.own(pending); await started.promise;
  let settled = false; pending.catch(() => { settled = true; });
  h.children[0].stderr.emit("data", Buffer.from("invalid decoded audio")); h.children[0].close(1);
  await new Promise(setImmediate); assert.equal(h.children[1].killed, true); assert.equal(settled, false);
  h.children[1].close(null); await assert.rejects(pending, { code: "audio-preparation-failed" });
  assertNoWorkingFiles(f); f.assertPreserved();
});

test("spawn error also waits for child close and stops the decoder peer", async t => {
  const h = controlledChildren(t), f = postStopFixture(t), started = deferred<void>();
  const pending = prepareMeetingAudio(f.storage, f.recording, randomUUID(), f.epochs, { deps: { ...nativeDeps(), spawn: () => {
    const child = h.child(); if (h.children.length === 2) started.resolve(); return child.asProcess();
  } } }); h.own(pending); await started.promise;
  let settled = false; pending.catch(() => { settled = true; });
  h.children[0].emit("error", new Error("spawn failed")); await new Promise(setImmediate);
  assert.ok(h.children.every(child => child.killed)); assert.equal(settled, false);
  h.children.forEach(child => child.close(null)); await assert.rejects(pending, { code: "audio-preparation-failed" }); assertNoWorkingFiles(f);
});

test("mid-native-correction abort waits for owned helper close and removes private floats", async t => {
  const controller = new AbortController(), h = controlledChildren(t, () => controller.abort()), f = postStopFixture(t), started = deferred<void>();
  const pending = prepareMeetingAudio(f.storage, f.recording, randomUUID(), f.epochs, { signal: controller.signal, deps: { ...nativeDeps(), spawn: (command, args, options) => {
    if (command !== helper) return spawn(command, args, options);
    const child = h.child(); fs.writeFileSync(args[2], Buffer.alloc(80)); started.resolve(); return child.asProcess();
  } } }); h.own(pending); await started.promise;
  let settled = false; pending.catch(() => { settled = true; }); controller.abort(); await new Promise(setImmediate);
  assert.ok(h.children.every(child => child.killed)); assert.equal(settled, false);
  h.children.forEach(child => child.close(null)); await assert.rejects(pending, { name: "AbortError" }); assertNoWorkingFiles(f); f.assertPreserved();
});

for (const category of [2, 3, 4, 5]) test(`native exit category ${category} fails locally without publication`, async t => {
  const h = controlledChildren(t), f = postStopFixture(t), runId = randomUUID();
  const pending = prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { deps: { ...nativeDeps(), spawn: (command, args, options) => {
    if (command !== helper) return spawn(command, args, options);
    const child = h.child(); fs.writeFileSync(args[2], Buffer.alloc(40));
    queueMicrotask(() => { child.stderr.emit("data", Buffer.from("meeting-resampler: synthetic failure (errno=0)")); child.close(category); });
    return child.asProcess();
  } } }); h.own(pending);
  await assert.rejects(pending, { code: "audio-preparation-failed" });
  assert.equal(fs.existsSync(f.storage.getDerivedAudioPath(f.recording.id, runId)), false); assertNoWorkingFiles(f); f.assertPreserved();
});

test("truncated decoded float output cannot pass native length validation", async t => {
  const f = postStopFixture(t), runId = randomUUID();
  const pending = prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { deps: { ...nativeDeps(), spawn: (command, args, options) => {
    if (command !== helper) return spawn(command, args, options);
    fs.truncateSync(args[0], fs.statSync(args[0]).size - 4); return spawn(command, args, options);
  } } });
  await assert.rejects(pending, { code: "audio-preparation-failed" }); assertNoWorkingFiles(f); f.assertPreserved();
});

for (const phase of ["correct", "assemble"]) test(`write-time ENOSPC during ${phase} stops owned work and removes partial outputs`, async t => {
  const h = controlledChildren(t), f = postStopFixture(t), runId = randomUUID();
  const pending = prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { deps: { ...nativeDeps(), availableBytes: () => Number.MAX_SAFE_INTEGER, spawn: (command, args, options) => {
    const fail = phase === "correct" ? command === helper : args.includes("-filter_complex");
    if (!fail) return spawn(command, args, options);
    const child = h.child(); fs.writeFileSync(phase === "correct" ? args[2] : args.at(-1)!, "partial");
    queueMicrotask(() => { child.stderr.emit("data", Buffer.from(phase === "correct" ? "write timeline (errno=28)" : "No space left on device")); child.close(phase === "correct" ? 4 : 1); }); return child.asProcess();
  } } }); h.own(pending);
  await assert.rejects(pending, { code: "audio-preparation-disk-full" });
  assert.equal(fs.existsSync(f.storage.getDerivedAudioPath(f.recording.id, runId)), false); assertNoWorkingFiles(f); f.assertPreserved();
});

for (const error of ["abort", "disk"]) test(`final-publication ${error} leaves no published or working file`, async t => {
  const f = postStopFixture(t), controller = new AbortController(), runId = randomUUID();
  const deps: MixerDeps = { ...nativeDeps() };
  if (error === "abort") deps.readHeader = file => { const header = fs.readFileSync(file).subarray(0, 4096); controller.abort(); return header; };
  else deps.rename = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  await assert.rejects(prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { signal: controller.signal, deps }), error === "abort" ? { name: "AbortError" } : { code: "audio-preparation-disk-full" });
  assert.equal(fs.existsSync(f.storage.getDerivedAudioPath(f.recording.id, runId)), false); assertNoWorkingFiles(f); f.assertPreserved();
});

test("two operations can pass admission; later ENOSPC fails only the affected operation", async t => {
  const h = controlledChildren(t), f = postStopFixture(t), bothAdmitted = deferred<void>();
  let admissions = 0;
  const admission = () => { if (++admissions === 2) bothAdmitted.resolve(); return Number.MAX_SAFE_INTEGER; };
  const winnerId = randomUUID(), failureId = randomUUID();
  const winner = prepareMeetingAudio(f.storage, f.recording, winnerId, f.epochs, { deps: { ...nativeDeps(), availableBytes: admission } });
  const failed = prepareMeetingAudio(f.storage, f.recording, failureId, f.epochs, { deps: { ...nativeDeps(), availableBytes: admission, spawn: (_command, args) => {
    const child = h.child(); fs.writeFileSync(args.at(-1)!, "partial decoded audio");
    bothAdmitted.promise.then(() => { child.stderr.emit("data", Buffer.from("No space left on device")); child.close(1); }); return child.asProcess();
  } } }); h.own(Promise.allSettled([winner, failed]));
  await assert.rejects(failed, { code: "audio-preparation-disk-full" }); const audio = await winner;
  assert.equal(admissions, 2); assert.equal(wavSamples(audio.path).length, 96000 * 2);
  assert.equal(fs.existsSync(f.storage.getDerivedAudioPath(f.recording.id, failureId)), false); assertNoWorkingFiles(f); f.assertPreserved();
});

test("closed but invalid final WAV never reaches the atomic publication boundary", async t => {
  const h = controlledChildren(t), f = postStopFixture(t), runId = randomUUID(); let renames = 0;
  const pending = prepareMeetingAudio(f.storage, f.recording, runId, f.epochs, { deps: { ...nativeDeps(), rename: () => { renames++; }, spawn: (command, args, options) => {
    if (!args.includes("-filter_complex")) return spawn(command, args, options);
    const child = h.child(); fs.writeFileSync(args.at(-1)!, "not a PCM WAV"); queueMicrotask(() => child.close(0)); return child.asProcess();
  } } }); h.own(pending);
  await assert.rejects(pending, { code: "audio-preparation-failed" }); assert.equal(renames, 0);
  assert.equal(fs.existsSync(f.storage.getDerivedAudioPath(f.recording.id, runId)), false); assertNoWorkingFiles(f); f.assertPreserved();
});
