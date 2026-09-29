const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-delete-all-audio-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const { registerTranscriptionDataHandlers }: typeof import("../../src/helpers/transcriptionDataIpcHandlers.ts") = require("../../src/helpers/transcriptionDataIpcHandlers.ts");
const DatabaseManager = require("../../src/helpers/database.ts");
const AudioStorageManager: typeof import("../../src/helpers/audioStorage.ts").AudioStorageManager = require("../../src/helpers/audioStorage.ts");

function isNativeBindingUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function setup(t: import("node:test").TestContext) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-delete-all-audio-"));
  let db;
  let audioStorage;
  try {
    db = new DatabaseManager();
    audioStorage = new AudioStorageManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  const handlers = new Map();
  registerTranscriptionDataHandlers(
    {
      handle: (channel: string, fn: unknown) => handlers.set(channel, fn),
      on: () => {},
    },
    {
      // The real managers: no mock stands in for the database seam here.
      database: db,
      audioStorage,
      deleteAllAudio: async () => audioStorage.deleteAllAudio(),
      deleteTranscriptionInternal: (id: unknown) => db.deleteTranscription(id),
      buildSpeakerMappings: () => ({}),
      queueNoteNavigation: async () => {},
      consumePendingNoteNavigation: () => null,
      retention: {
        getCurrentSettings: () => ({
          audioRetentionDays: 0,
          transcriptRetentionDays: 0,
          dataRetentionEnabled: false,
          localHistoryPolicyResolved: true,
        }),
        getOwner: () => null,
        hasSynced: () => true,
        onSettingsChanged: () => {},
      },
      broadcast: () => {},
      logger: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    }
  );
  return { db, audioStorage, handlers };
}

function audioBackedTranscription(db: any, audioStorage: any, text: string) {
  const { id } = db.saveTranscription(text);
  const saved = audioStorage.saveAudio(id, Buffer.from(`audio-${text}`));
  assert.equal(saved.success, true);
  db.updateTranscriptionAudio(id, {
    hasAudio: 1,
    audioDurationMs: 1500,
    provider: "test",
    model: "test-model",
  });
  return id;
}

test("delete-all-audio removes files, clears has_audio, keeps records, is repeatable", async (t: import("node:test").TestContext) => {
  const setupResult = setup(t);
  if (!setupResult) return;
  const { db, audioStorage, handlers } = setupResult;

  // The production wiring now provides a real read of flagged ids.
  assert.equal(typeof db.getAudioFlaggedIds, "function");

  const id1 = audioBackedTranscription(db, audioStorage, "first transcript");
  const id2 = audioBackedTranscription(db, audioStorage, "second transcript");
  db.saveTranscription("transcript only");
  assert.deepEqual(
    db.getAudioFlaggedIds().map((row: any) => row.id).sort(),
    [id1, id2]
  );
  assert.equal(fs.readdirSync(audioStorage.audioDir).length, 2);

  const handler = handlers.get("delete-all-audio");
  assert.ok(handler, "delete-all-audio must be registered");

  const result = await handler({});
  assert.deepEqual(result, { deleted: 2, failed: 0 });

  assert.equal(fs.readdirSync(audioStorage.audioDir).length, 0, "storage must be empty");
  assert.deepEqual(db.getAudioFlaggedIds(), []);
  for (const id of [id1, id2]) {
    const row = db.getTranscriptionById(id);
    assert.equal(row.has_audio, 0);
    assert.ok(row.text.includes("transcript"), "transcript record must survive");
  }
  assert.equal(db.getTranscriptions(50).length, 3, "no record may be deleted");

  const second = await handler({});
  assert.deepEqual(second, { deleted: 0, failed: 0 });
});

test("delete-all-audio on an empty storage is a no-op", async (t: import("node:test").TestContext) => {
  const setupResult = setup(t);
  if (!setupResult) return;
  const { db, audioStorage, handlers } = setupResult;

  const result = await handlers.get("delete-all-audio")({});
  assert.deepEqual(result, { deleted: 0, failed: 0 });
  assert.equal(fs.readdirSync(audioStorage.audioDir).length, 0);
  assert.deepEqual(db.getAudioFlaggedIds(), []);
});

test.after(() => {
  Module._load = originalLoad;
});
