const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const { EventEmitter }: typeof import("node:events") = require("node:events");
const { createDb }: typeof import("../../../helpers/harness/db.ts") = require("../../../helpers/harness/db.ts");
const { getUserDataDir }: typeof import("../../../helpers/harness/electronStub.ts") = require("../../../helpers/harness/electronStub.ts");
const { savePcmEpoch }: typeof import("../../../lib/meetingAudioFixture.ts") = require("../../../lib/meetingAudioFixture.ts");
const { MeetingRecordingStorage }: typeof import("../../../../src/helpers/meetingRecordingStorage.js") = require("../../../../src/helpers/meetingRecordingStorage.ts");
const { createMeetingAudioOperationRegistry }: typeof import("../../../../src/helpers/meetingAudioExport.js") = require("../../../../src/helpers/meetingAudioExport.ts");
const { meetingProcessingChannels }: typeof import("../../../../src/contracts/meetingProcessing.js") = require("../../../../src/contracts/meetingProcessing.ts");

test("playback leases isolate processing files and release only their owner's temporary audio", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Playback", "", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config: null }, "2026-09-30T10:00:00.000Z");
  db.createMeetingRecordingEpoch(recording.id, "mic", 0, 0);
  savePcmEpoch(storage, recording.id, "mic", 0, Buffer.alloc(48000, 5));
  db.updateMeetingRecordingEpochRecovery(recording.id, "mic", 0, storage.recoverEpoch(recording.id, "mic", 0));
  const run = db.finalizeMeetingRecording(recording.id, { captureState: "incomplete", endedAt: "2026-09-30T10:00:01.000Z" }).initialRun;
  const processingFile = storage.getDerivedAudioPath(recording.id, run.id);
  fs.writeFileSync(processingFile, "processing owns this input");
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const Module = require("node:module");
  const originalLoad = Module._load;
  const electron = require("electron");
  Module._load = function(request: string, ...args: unknown[]) {
    if (request === "electron") return { ...electron, ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => handlers.set(channel, handler) } };
    return originalLoad.call(this, request, ...args);
  };
  try {
    const IPCHandlers = require("../../../../src/helpers/ipcHandlers.ts");
    IPCHandlers.prototype._registerMeetingRecordingAssetHandlers.call({
      databaseManager: db, audioStorageManager: { meetingRecordings: storage },
      _meetingAudioOperations: createMeetingAudioOperationRegistry(),
    });
  } finally { Module._load = originalLoad; }
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  type Playback = { success: boolean; path: string; leaseId: string };
  const result = await handlers.get(meetingProcessingChannels.getPlaybackPath)!({ sender }, { recordingId: recording.id }) as Playback;
  assert.equal(result.success, true);
  assert.notEqual(result.path, processingFile);
  assert.equal(fs.existsSync(result.path), true);
  assert.equal(sender.listenerCount("destroyed"), 1);
  await handlers.get(meetingProcessingChannels.releasePlayback)!({ sender: { id: 2 } }, { leaseId: result.leaseId });
  assert.equal(fs.existsSync(result.path), true, "another renderer cannot release the owner’s file");
  await handlers.get(meetingProcessingChannels.releasePlayback)!({ sender }, { leaseId: result.leaseId });
  assert.equal(fs.existsSync(result.path), false);
  assert.equal(sender.listenerCount("destroyed"), 0);
  assert.equal(fs.readFileSync(processingFile, "utf8"), "processing owns this input");
  const next = await handlers.get(meetingProcessingChannels.getPlaybackPath)!({ sender }, { recordingId: recording.id }) as Playback;
  sender.emit("destroyed");
  assert.equal(fs.existsSync(next.path), false);
  assert.equal(fs.existsSync(processingFile), true);
});
