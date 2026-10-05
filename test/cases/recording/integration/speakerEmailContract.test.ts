import type { TestContext } from "node:test";

const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createDb,
}: typeof import("../../../helpers/harness/db.ts") = require("../../../helpers/harness/db.ts");

const {
  speakerChannels,
}: typeof import("../../../../src/contracts/speakerProfiles.ts") = require("../../../../src/contracts/speakerProfiles.ts");

const {
  registerSpeakerHandlers,
}: typeof import("../../../../src/helpers/speakerIpcHandlers.ts") = require("../../../../src/helpers/speakerIpcHandlers.ts");

// Float32-LE buffers, the storage format the DB returns for embeddings.
function embedding(values: number[]) {
  return Buffer.from(new Float32Array(values).buffer);
}

interface Harness {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  retroactive: Array<{ id: number; display_name: string; email: string | null; embedding: Buffer }>;
}

function registerWithRealDb(db: any): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const retroactive: Harness["retroactive"] = [];
  registerSpeakerHandlers(
    {
      handle: (channel, fn) =>
        handlers.set(channel as string, fn as (...args: unknown[]) => unknown),
    },
    {
      databaseManager: db,
      diarizationManager: {
        downloadModels: async () => ({ success: true, path: "" }),
        isAvailable: () => false,
        isModelDownloaded: () => false,
        isVadModelDownloaded: () => false,
        deleteModels: async () => ({}),
        cancelDownload: async () => ({ success: true }),
      },
      retroactiveMapping: (profile) => retroactive.push(profile),
      tryAutoLabelOneOnOne: () => {},
      logError: () => {},
    }
  );

  return {
    invoke: (channel, ...args) =>
      Promise.resolve(
        handlers.get(channel)!({ sender: { isDestroyed: () => true, send() {} } }, ...args)
      ),
    retroactive,
  };
}

test("attach-speaker-email returns the persisted profile and fires retroactive mapping", async (t: TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const profile = db.upsertSpeakerProfile("Alice", null, embedding([1, 0.2, 0]));
  assert.ok(profile);
  const h = registerWithRealDb(db);

  const result = await h.invoke(
    speakerChannels.attachSpeakerEmail,
    profile.id,
    "alice@example.com"
  );

  assert.equal(result.success, true);
  assert.equal(result.profile.id, profile.id);
  assert.equal(result.profile.display_name, "Alice");
  assert.equal(result.profile.email, "alice@example.com");
  assert.ok(result.profile.sample_count >= 1);
  // The internal mapping got the real embedding buffer, not a truncated DTO.
  assert.equal(h.retroactive.length, 1);
  assert.ok(Buffer.isBuffer(h.retroactive[0].embedding));
  assert.equal(h.retroactive[0].id, profile.id);
  // And the write is actually persisted.
  assert.equal(
    db.getSpeakerProfiles().find((p: any) => p.id === profile.id)?.email,
    "alice@example.com"
  );
});

test("attach-speaker-email for a missing profile is a failure, not success", async (t: TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const h = registerWithRealDb(db);

  const result = await h.invoke(speakerChannels.attachSpeakerEmail, 999999, "nobody@example.com");

  assert.equal(result.success, false);
  assert.match(String(result.error), /not found/i);
  assert.equal(h.retroactive.length, 0);
});

test("attach-speaker-email removal keeps email nullable", async (t: TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const profile = db.upsertSpeakerProfile("Bob", "bob@example.com", embedding([0, 1, 0]));
  assert.ok(profile);
  const h = registerWithRealDb(db);

  const result = await h.invoke(speakerChannels.attachSpeakerEmail, profile.id, null);

  assert.equal(result.success, true);
  assert.equal(result.profile.email, null);
  assert.equal(db.getSpeakerProfiles().find((p: any) => p.id === profile.id)?.email, null);
});

test("save-note-speaker-embeddings passes the DB row shape and persists buffers", async (t: TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const { note } = db.saveNote("Meeting", "content");
  assert.ok(note);
  const h = registerWithRealDb(db);

  const result = await h.invoke(speakerChannels.saveNoteSpeakerEmbeddings, note.id, {
    SPEAKER_00: [0.5, 0.5, 0.5, 0.5],
  });

  assert.deepEqual(result, { success: true });
  const stored = db.getNoteSpeakerEmbeddings(note.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].speaker_id, "SPEAKER_00");
  assert.equal(stored[0].embedding.byteLength, 16);
});
