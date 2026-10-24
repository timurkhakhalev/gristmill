const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  speakerChannels,
}: typeof import("../../src/contracts/speakerProfiles.ts") = require("../../src/contracts/speakerProfiles.ts");

const {
  registerSpeakerHandlers,
}: typeof import("../../src/helpers/speakerIpcHandlers.ts") = require("../../src/helpers/speakerIpcHandlers.ts");

function embeddingBuffer(samples = 4) {
  return Buffer.from(new Float32Array(new Array(samples).fill(0.5)).buffer);
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map();

  const calls: any = {
    retroactive: [],
    autoLabel: [],
    upserts: [],
    savedEmbeddings: [],
    progress: [],
  };

  const database = {
    searchContacts: () => [{ email: "a@example.net", display_name: "A" }],
    createContact: (contacts: unknown) => {
      calls.upserts.push(contacts);
    },
    updateContact: (email: unknown, name: unknown) => {
      calls.renames = calls.renames || [];
      calls.renames.push([email, name]);
    },
    upsertSpeakerProfile: (
      displayName: unknown,
      email: unknown,
      embedding: unknown,
      profileId: string
    ) => {
      const profile = {
        id: 11,
        display_name: displayName,
        contact_id: email,
        embedding,
        sample_count: 1,
      };

      calls.profiles = calls.profiles || [];
      calls.profiles.push({ displayName, email, profileId, embedding });

      return profile;
    },
    getSpeakerMappings: () => [
      { note_id: 1, speaker_id: "speaker_0", profile_id: null, display_name: "A" },
    ],
    getNoteSpeakerEmbeddings: () => [{ speaker_id: "speaker_0", embedding: embeddingBuffer() }],
    setSpeakerMapping: (...args: unknown[]) => {
      calls.setMapping = args;
    },
    removeSpeakerMapping: (...args: unknown[]) => {
      calls.removeMapping = args;
    },
    getSpeakerProfiles: () => [
      { id: 11, display_name: "A", email: null, sample_count: 1, created_at: "t", updated_at: "t" },
    ],
    attachContactToProfile: (profileId: string, email: unknown) => ({
      id: profileId,
      display_name: "A",
      contact_id: email,
      embedding: embeddingBuffer(),
      sample_count: 2,
    }),
    saveNoteSpeakerEmbeddings: (noteId: unknown, embeddings: unknown) => {
      calls.savedEmbeddings.push({ noteId, embeddings });
    },
    ...(overrides.database as any),
  };

  const diarization = {
    downloadModels: async (onProgress: any) => {
      onProgress({ type: "progress", stage: "embedding", percentage: 40 });

      return { success: true, path: "/models" };
    },
    isAvailable: () => true,
    isModelDownloaded: () => true,
    isVadModelDownloaded: () => true,
    deleteModels: async () => {},
    cancelDownload: () => ({ success: true, message: "Download cancelled" }),
    ...(overrides.diarization as any),
  };

  registerSpeakerHandlers(
    { handle: (c: unknown, fn: unknown) => handlers.set(c, fn) },
    {
      databaseManager: database,
      diarizationManager: diarization,
      retroactiveMapping: (profile: unknown) => {
        calls.retroactive.push(profile);
      },
      tryAutoLabelOneOnOne: (noteId: unknown) => {
        calls.autoLabel.push(noteId);
      },
      logError: () => {},
      ...(overrides.deps as any),
    }
  );

  const sender = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    send(channel: string, payload: unknown) {
      calls.progress.push({ channel, payload });
    },
  };

  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)({ sender }, ...args);

  return { handlers, invoke, calls, sender };
}

test("set-speaker-mapping promotes the note embedding into a profile", async () => {
  const h = createHarness();

  const result = await h.invoke(
    speakerChannels.setSpeakerMapping,
    1,
    "speaker_0",
    "Alice",
    null,
    null
  );

  assert.deepEqual(result, { success: true, profileId: 11 });
  // The saved note embedding feeds profile promotion.
  assert.equal(h.calls.profiles[0].displayName, "Alice");
  assert.equal(h.calls.profiles[0].profileId, null);
  assert.ok(h.calls.profiles[0].embedding instanceof Buffer);
  assert.equal(h.calls.retroactive.length, 1);
  assert.deepEqual(h.calls.setMapping, [1, "speaker_0", 11, "Alice"]);
});

test("set-speaker-mapping without any embedding only writes the mapping", async () => {
  const h = createHarness({
    database: { getNoteSpeakerEmbeddings: () => [] },
  });

  const result = await h.invoke(
    speakerChannels.setSpeakerMapping,
    1,
    "speaker_0",
    "Carol",
    null,
    7
  );

  assert.deepEqual(result, { success: true, profileId: 7 });
  assert.equal(h.calls.profiles, undefined, "no embedding means no profile upsert");
  assert.equal(h.calls.retroactive.length, 0);
  assert.deepEqual(h.calls.setMapping, [1, "speaker_0", 7, "Carol"]);
});

test("attach-speaker-contact projects the public DTO and fires retroactive mapping", async () => {
  const h = createHarness();
  const result = await h.invoke(speakerChannels.attachSpeakerContact, 11, 3);
  assert.deepEqual(result, {
    success: true,
    profile: { id: 11, display_name: "A", contact_id: 3, sample_count: 2 },
  });
  assert.equal(h.calls.retroactive.length, 1);
});

test("attach-speaker-contact failures keep the error shape", async () => {
  const h = createHarness({
    database: {
      attachContactToProfile: () => {
        throw new Error("db locked");
      },
    },
  });

  const result = await h.invoke(speakerChannels.attachSpeakerContact, 11, null);
  assert.equal(result.success, false);
  assert.equal(result.error, "db locked");
});

test("save-note-speaker-embeddings stores float32 buffers and triggers auto-label", async () => {
  const h = createHarness();

  const result = await h.invoke(speakerChannels.saveNoteSpeakerEmbeddings, 9, {
    speaker_0: [0.5, 0.5],
  });

  assert.deepEqual(result, { success: true });
  const saved = h.calls.savedEmbeddings[0];
  assert.equal(saved.noteId, 9);
  assert.equal(saved.embeddings.length, 1);
  assert.equal(saved.embeddings[0].speakerId, "speaker_0");
  assert.ok(saved.embeddings[0].embedding instanceof Buffer);
  assert.equal(saved.embeddings[0].embedding.length, 8);
  assert.deepEqual(h.calls.autoLabel, [9]);
});

test("download progress reaches a live sender and dies with a destroyed one", async () => {
  const h = createHarness();
  const result = await h.invoke(speakerChannels.downloadDiarizationModels);
  assert.deepEqual(result, { success: true, path: "/models" });
  assert.equal(h.calls.progress.length, 1);
  assert.equal(h.calls.progress[0].channel, speakerChannels.diarizationDownloadProgress);

  const h2 = createHarness();
  h2.sender.destroyed = true;
  const failed = await h2.invoke(speakerChannels.downloadDiarizationModels);
  assert.equal(failed.success, true);
  assert.equal(h2.calls.progress.length, 0, "destroyed senders get nothing");
});

test("download failures forward the coded error to the sender", async () => {
  const h = createHarness({
    diarization: {
      downloadModels: async () => {
        const err = new Error("interrupted") as Error & { code: string };
        err.code = "DOWNLOAD_CANCELLED";
        throw err;
      },
    },
  });

  const result = await h.invoke(speakerChannels.downloadDiarizationModels);
  assert.equal(result.success, false);
  assert.equal(result.code, "DOWNLOAD_CANCELLED");
  assert.equal(h.calls.progress[0].payload.type, "error");
  assert.equal(h.calls.progress[0].payload.code, "DOWNLOAD_CANCELLED");
});

test("diarization status combines main and vad model availability", async () => {
  const ready = await createHarness().invoke(speakerChannels.getDiarizationModelStatus);
  assert.deepEqual(ready, { available: true, modelsDownloaded: true });

  const partial = createHarness({
    diarization: { isVadModelDownloaded: () => false },
  });

  assert.deepEqual(await partial.invoke(speakerChannels.getDiarizationModelStatus), {
    available: true,
    modelsDownloaded: false,
  });
});

test("contact mutations validate ID inputs before database calls", async () => {
  const h = createHarness();
  await assert.rejects(h.invoke(speakerChannels.updateContact, "email@example.com", { displayName: "Synthetic", email: null, telegramUsername: null }));
  await assert.rejects(h.invoke(speakerChannels.createContact, { displayName: "", email: null, telegramUsername: null }));
  assert.deepEqual(h.calls.upserts, []);
  assert.equal(h.calls.renames, undefined);
});

test("mapping reads and deletes delegate to the database", async () => {
  const h = createHarness();
  const mappings = await h.invoke(speakerChannels.getSpeakerMappings, 1);
  assert.equal(mappings[0].speaker_id, "speaker_0");
  assert.deepEqual(await h.invoke(speakerChannels.removeSpeakerMapping, 1, "speaker_0"), {
    success: true,
  });
  assert.deepEqual(h.calls.removeMapping, [1, "speaker_0"]);
});

test("profiles list the public DTO without the embedding buffer", async () => {
  const h = createHarness();
  const profiles = await h.invoke(speakerChannels.getSpeakerProfiles);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, 11);
  assert.equal("embedding" in profiles[0], false);
});
