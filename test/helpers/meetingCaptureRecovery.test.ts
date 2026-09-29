const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const { spawn }: typeof import("node:child_process") = require("node:child_process");
const { createDb } = require("./harness/db.ts");
const { getUserDataDir }: typeof import("./harness/electronStub.ts") = require("./harness/electronStub.ts");
const MeetingRecordingStorage: typeof import("../../src/helpers/meetingRecordingStorage.ts").MeetingRecordingStorage = require("../../src/helpers/meetingRecordingStorage.ts");
const DatabaseManager = require("../../src/helpers/database.ts");
const { MeetingCaptureSession } = require("../../src/helpers/meetingCaptureSession.ts");
const { MeetingCaptureWriteQueue }: typeof import("../../src/helpers/meetingCaptureWriteQueue.ts") = require("../../src/helpers/meetingCaptureWriteQueue.ts");

const RECORDING_ID = "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1";
const RUN_ID = "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2";

function createCaptureFakes({ failWrite = false } = {}) {
  type Recording = { id: string; noteId: number; config: unknown; startedAt: string; captureState: string; captureErrorCode?: string | null };
  const database = {
    recordings: [] as Recording[],
    epochs: [] as { recordingId: string; source: string; epochIndex: number; startFrame: number }[],
    recoveries: [] as unknown[],
    finalizations: [] as { recordingId: string; input: { captureState: string; endedAt: string; errorCode?: string | null } }[],
    createMeetingRecording(noteId: number, config: unknown, startedAt: string, id: string) {
      const recording = { id, noteId, config, startedAt, captureState: "recording" };
      this.recordings.push(recording);
      return recording;
    },
    createMeetingRecordingEpoch(recordingId: string, source: string, epochIndex: number, startFrame: number) {
      this.epochs.push({ recordingId, source, epochIndex, startFrame });
    },
    updateMeetingRecordingEpochRecovery(recordingId: string, source: string, epochIndex: number, result: Record<string, unknown>) {
      this.recoveries.push({ recordingId, source, epochIndex, ...result });
    },
    markMeetingRecordingFinalizing(recordingId: string) {
      const recording = this.recordings.find((item) => item.id === recordingId);
      if (!recording) throw new Error("Recording not found");
      recording.captureState = "finalizing";
    },
    finalizeMeetingRecording(recordingId: string, input: { captureState: string; endedAt: string; errorCode?: string | null }) {
      this.finalizations.push({ recordingId, input });
      const recording = this.recordings.find((item) => item.id === recordingId);
      if (!recording) throw new Error("Recording not found");
      recording.captureState = input.captureState;
      recording.captureErrorCode = input.errorCode ?? null;
      return { recording, initialRun: { id: RUN_ID } };
    },
  };
  const storage = {
    files: new Map<string, Buffer[]>(),
    openEpochWriter(recordingId: string, source: string, epochIndex: number) {
      this.files.set(`${recordingId}:${source}:${epochIndex}`, []);
    },
    appendEpochSamples(recordingId: string, source: string, epochIndex: number, samples: Uint8Array) {
      if (failWrite) throw new Error("disk full");
      const buffers = this.files.get(`${recordingId}:${source}:${epochIndex}`);
      assert.ok(buffers);
      buffers.push(Buffer.from(samples));
    },
    closeEpochWriter() {},
    recoverEpoch(recordingId: string, source: string, epochIndex: number) {
      const buffers = this.files.get(`${recordingId}:${source}:${epochIndex}`) ?? [];
      return {
        frameCount: buffers.reduce((total, buffer) => total + buffer.length / 2, 0),
        ignoredTrailingBytes: 0,
        errorCode: null,
      };
    },
  };
  return { database, storage };
}

const packet = (epochIndex: number, epochStartFrame: unknown, sequence: unknown, sampleOffset: number) => ({
  epochIndex,
  epochStartFrame,
  sequence,
  sampleOffset,
});

test("killed encoders recover complete Ogg pages at several write positions", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const { getFFmpegPath } = require("../../src/helpers/ffmpegUtils.ts") as typeof import("../../src/helpers/ffmpegUtils.js");
  const { OpusPages, MEETING_OPUS_ARGS } = require("../../src/helpers/meetingOpus.ts") as typeof import("../../src/helpers/meetingOpus.js");
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const recordings: Array<{ id: string; frames: number }> = [];
  for (const targetPages of [3, 5, 8]) {
    const note = db.saveNote(`Crash ${targetPages}`, "", "meeting").note!;
    const recording = db.createMeetingRecording(note.id, { config: null });
    db.createMeetingRecordingEpoch(recording.id, "mic", 0, 0);
    const file = storage.createEpochFile(recording.id, "mic", 0);
    const child = spawn(getFFmpegPath()!, ["-hide_banner", "-loglevel", "error", "-re", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", ...MEETING_OPUS_ARGS, "-flush_packets", "1", "-f", "ogg", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const pages = new OpusPages();
    let count = 0;
    let frames = 0;
    child.stdout.on("data", (chunk: Buffer) => pages.push(chunk, (page) => {
      if (count >= targetPages) return;
      fs.appendFileSync(file, page);
      count++;
      frames = pages.frameCount;
      if (count === targetPages) child.kill("SIGKILL");
    }));
    child.stdin.on("error", () => {});
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    t.after(() => child.kill("SIGKILL"));
    child.stdin.end(Buffer.alloc(24_000 * 2 * 4, 3));
    await closed;
    assert.equal(count, targetPages);
    assert.ok(frames > 0);
    const bytes = fs.readFileSync(file);
    const recovered = storage.recoverEpoch(recording.id, "mic", 0);
    assert.equal(recovered.frameCount, frames);
    assert.equal(recovered.errorCode, "opus-interrupted");
    assert.deepEqual(fs.readFileSync(file), bytes, "recovery preserves original pages");
    recordings.push({ id: recording.id, frames });
  }
  db.close();
  const reopened = new DatabaseManager();
  try {
    storage.recover(reopened);
    for (const { id, frames } of recordings) {
      assert.equal(reopened.listMeetingRecordingEpochs(id)[0].frameCount, frames);
      assert.equal(reopened.getMeetingRecording(id).captureState, "incomplete");
    }
  } finally { reopened.close(); }
});

test("capture writes source epochs separately and finalizes restart gaps as incomplete once", async () => {
  const { database, storage } = createCaptureFakes();
  const origin = new Date("2026-09-24T10:00:00.000Z");
  const capture = MeetingCaptureSession.create(database, storage, 12, {
    config: null,
    configError: { code: "missing-config" },
  }, origin, RECORDING_ID);
  const micA = Buffer.alloc(4_800, 1);
  const micB = Buffer.alloc(4_800, 2);
  const system = Buffer.alloc(2_400, 3);

  capture.appendRendererSamples("mic", packet(0, 0, 0, 0), micA);
  capture.appendRendererSamples("mic", packet(0, 0, 1, 2_400), micB);
  capture.appendRendererSamples("mic", packet(1, 12_000, 0, 0), Buffer.alloc(4_800, 4));
  capture.appendRendererSamples("system", packet(0, 24_000, 0, 0), system);

  assert.deepEqual(
    database.epochs.map(({ source, epochIndex, startFrame }) => [source, epochIndex, startFrame]),
    [["mic", 0, 0], ["mic", 1, 12_000], ["system", 0, 24_000]]
  );
  assert.equal(storage.files.get(`${RECORDING_ID}:mic:0`)?.[0]?.equals(micA), true);
  assert.equal(storage.files.get(`${RECORDING_ID}:system:0`)?.[0]?.equals(system), true);

  const request = { lastSequence: { mic: 0, system: 0 } };
  const [first, repeated] = await Promise.all([capture.stop(request), capture.stop(request)]);
  assert.equal(first.recordingId, RECORDING_ID);
  assert.equal(first.captureState, "incomplete");
  assert.equal(first.initialRunId, RUN_ID);
  assert.equal(repeated.initialRunId, RUN_ID);
  assert.equal(database.finalizations.length, 1);
});

test("owner loss records the last saved audio time instead of a later finalization time", async () => {
  const { database, storage } = createCaptureFakes();
  const origin = new Date("2026-09-24T10:00:00.000Z");
  const capture = MeetingCaptureSession.create(database, storage, 12, null, origin, RECORDING_ID);
  capture.appendRendererSamples("mic", packet(0, 0, 0, 0), Buffer.alloc(4_800, 1));
  capture.appendNativeSamples("system", Buffer.alloc(4_800, 2), new Date(origin.getTime() + 250));
  capture.markCaptureFailure("renderer-lost");

  const result = await capture.stop({ lastSequence: {} });
  assert.equal(result.captureState, "incomplete");
  assert.equal(database.finalizations[0].input.endedAt, "2026-09-24T10:00:00.350Z");
});

test("main-owned native system audio drains without a renderer sequence", async () => {
  const { database, storage } = createCaptureFakes();
  const origin = new Date("2026-09-24T10:00:00.000Z");
  const capture = MeetingCaptureSession.create(database, storage, 12, null, origin, RECORDING_ID);

  capture.appendRendererSamples("mic", packet(0, 0, 0, 0), Buffer.alloc(4_800, 1));
  capture.appendNativeSamples("system", Buffer.alloc(48_000, 2), new Date(origin.getTime() + 100));
  const result = await capture.stop({ lastSequence: { mic: 0, system: -1 } });

  assert.equal(result.captureState, "ready");
  const nativeChunks = storage.files.get(`${RECORDING_ID}:system:0`);
  assert.ok(nativeChunks);
  assert.equal(nativeChunks.length, 10);
  assert.equal(nativeChunks.reduce((total, chunk) => total + chunk.length, 0), 48_000);
  assert.equal(nativeChunks.every((chunk) => chunk.length <= 4_800), true);
  assert.equal(database.finalizations.length, 1);
});

test("disk-full writes are retained as incomplete errors", async () => {
  const { database, storage } = createCaptureFakes({ failWrite: true });
  const capture = MeetingCaptureSession.create(database, storage, 12, null, new Date(), RECORDING_ID);

  assert.throws(
    () => capture.appendRendererSamples("mic", packet(0, 0, 0, 0), Buffer.alloc(4_800)),
    /disk full/
  );
  const result = await capture.stop({ lastSequence: { mic: -1 } });
  assert.equal(result.captureState, "incomplete");
  assert.equal(result.errorCode, "audio-write-failed");
  assert.equal(database.finalizations.length, 1);
});

test("short PCM frames and out-of-order packets are rejected", async () => {
  const { database, storage } = createCaptureFakes();
  const capture = MeetingCaptureSession.create(database, storage, 12, null, new Date(), RECORDING_ID);

  assert.throws(
    () => capture.appendRendererSamples("mic", packet(0, 0, 0, 0), Buffer.from([1, 2, 3])),
    /whole frames|PCM16LE/
  );
  await capture.stop({ lastSequence: { mic: -1 } });

  const nextId = "c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3";
  const second = MeetingCaptureSession.create(database, storage, 12, null, new Date(), nextId);
  assert.throws(
    () => second.appendRendererSamples("mic", packet(0, 0, 1, 0), Buffer.alloc(4_800)),
    /out of order/
  );
  const result = await second.stop({ lastSequence: { mic: -1 } });
  assert.equal(result.captureState, "incomplete");
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("write queue waits for delayed disk acknowledgement and rejects late packets after drain", async () => {
  const writeGate = deferred();
  let writes = 0;
  const queue = new MeetingCaptureWriteQueue({
    write: () => { writes += 1; return writeGate.promise; },
    onFailure: (error: unknown) => { throw error; },
    maxFrames: 2,
    maxAgeMs: 500,
  });
  const pending = queue.write(Buffer.from([1]), 2);
  await new Promise(setImmediate);
  const drain = queue.drain();
  await assert.rejects(queue.write(Buffer.from([2]), 1), /closed/);
  assert.equal(queue.unacknowledgedFrames, 2);
  writeGate.resolve();
  await pending;
  await drain;
  assert.equal(writes, 1);
  assert.equal(queue.unacknowledgedFrames, 0);
});

test("default capture queue preserves audio through a one-second write backlog", async () => {
  const writeGate = deferred();
  const failures: string[] = [];
  const queue = new MeetingCaptureWriteQueue({
    write: () => writeGate.promise,
    onFailure: (error: Error) => failures.push(error.message),
  });
  const first = queue.write(Buffer.from([1]), 24_000);
  const second = queue.write(Buffer.from([2]), 24_000);
  assert.equal(queue.unacknowledgedFrames, 48_000);
  writeGate.resolve();
  await Promise.all([first, second, queue.drain()]);
  assert.equal(queue.unacknowledgedFrames, 0);
  assert.deepEqual(failures, []);
});

test("write queue stops at its PCM backlog limit and surfaces delayed writer failure", async () => {
  const writeGate = deferred();
  const failures: unknown[] = [];
  const queue = new MeetingCaptureWriteQueue({
    write: () => writeGate.promise,
    onFailure: (error) => failures.push(error.message),
    maxFrames: 2,
    maxAgeMs: 500,
  });
  const first = queue.write(Buffer.from([1]), 2);
  await new Promise(setImmediate);
  await assert.rejects(queue.write(Buffer.from([2]), 1), /5000 ms/);
  await assert.rejects(first, /5000 ms/);
  await assert.rejects(queue.drain(), /5000 ms/);
  assert.deepEqual(failures, ["Meeting capture exceeded the 5000 ms write backlog"]);
});
