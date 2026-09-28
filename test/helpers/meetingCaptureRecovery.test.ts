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

test("process kills recover only complete PCM frames at several write positions", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const childScript = `
    const fs = require("node:fs");
    const fd = fs.openSync(process.argv.at(-1), "a");
    let count = 0;
    process.stdin.on("data", () => {
      fs.writeSync(fd, Buffer.alloc(4800, count & 255));
      count += 1;
      process.stdout.write(count + "\\n");
    });
  `;

  const recordings = [];
  for (const targetWrites of [1, 3, 7]) {
    const note = db.saveNote(`Crash ${targetWrites}`, "", "meeting").note;
    const recording = db.createMeetingRecording(note.id, { config: null });
    db.createMeetingRecordingEpoch(recording.id, "mic", 0, 0);
    const rawPath = storage.createEpochFile(recording.id, "mic", 0);
    recordings.push({ recording, targetWrites });
    const child = spawn(process.execPath, ["-e", childScript, rawPath], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code: string, signal: unknown) => resolve({ code, signal }));
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      let newline = output.indexOf("\n");
      while (newline !== -1) {
        const count = Number(output.slice(0, newline));
        output = output.slice(newline + 1);
        if (count === targetWrites) child.kill("SIGKILL");
        else child.stdin.write("write\n");
        newline = output.indexOf("\n");
      }
    });
    child.once("spawn", () => child.stdin.write("write\n"));
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });

    const bytes = fs.readFileSync(rawPath);
    const expected = Buffer.concat(
      Array.from({ length: targetWrites }, (_, index) => Buffer.alloc(4_800, index))
    );
    assert.deepEqual(bytes, expected);
  }

  db.close();
  const reopened = new DatabaseManager();
  try {
    const recovered = storage.recover(reopened);
    for (const { recording, targetWrites } of recordings) {
      const epoch = reopened.listMeetingRecordingEpochs(recording.id)[0];
      assert.equal(recovered.finalized.includes(recording.id), true);
      assert.equal(epoch.frameCount, targetWrites * 2_400);
      assert.equal(epoch.ignoredTrailingBytes, 0);
      assert.equal(reopened.getMeetingRecording(recording.id).captureState, "incomplete");
    }
  } finally {
    reopened.close();
  }
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
  await assert.rejects(queue.write(Buffer.from([2]), 1), /500 ms/);
  await assert.rejects(first, /500 ms/);
  await assert.rejects(queue.drain(), /500 ms/);
  assert.deepEqual(failures, ["Meeting capture exceeded the 500 ms write backlog"]);
});
