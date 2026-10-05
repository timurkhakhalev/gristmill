// The renderer side of the issue #32 cancel fix: transcribeFile forwards the
// managed requestId into the BYOK call (it previously only reached the local
// route), and cancelBatch hard-cancels the current batch item's execution
// instead of only discarding its late result.
const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createRendererServer,
  installBrowserGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

type TestContext = import("node:test").TestContext;

interface HangTranscriptionMock {
  start(requestId: string): Promise<unknown>;
  savedNote?: boolean;
}

type GlobalWithMocks = typeof globalThis & {
  __hangTranscription?: HangTranscriptionMock;
  __twoBatchTranscription?: HangTranscriptionMock;
};

const cfg = (overrides = {}) => ({
  useLocalWhisper: false,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  parakeetModel: "p",
  cohereModel: "c",
  getApiKey: () => "direct-key",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionBaseUrl: "",
  cloudTranscriptionModel: "whisper-1",
  language: "en",
  transcriptionMode: "providers",
  ...overrides,
});

test("transcribeFile passes the requestId to the BYOK handler", async (t: TestContext) => {
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openh-file-byok-request-id-",
  });

  const { transcribeFile } = (await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  )) as typeof import("../../src/services/fileTranscription.ts");

  let byokOptions: Record<string, unknown> | undefined;
  window.electronAPI.transcribeAudioFileByok = async (options: Record<string, unknown>) => {
    byokOptions = options;

    return { success: true, text: "direct" };
  };

  await transcribeFile("/tmp/audio.wav", cfg(), false, { requestId: "req-42" });
  assert.equal(byokOptions!.requestId, "req-42");

  // Without managed cancellation (voice drafts, plain transcribeFile) the id
  // is simply absent — those flows register nothing.
  await transcribeFile("/tmp/audio.wav", cfg(), false);
  assert.equal(byokOptions!.requestId, undefined);
});

test("cancelBatch hard-cancels the current item and discards its late result", async (t: TestContext) => {
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const cancels: string[] = [];
  window.electronAPI.cancelUrlDownload = async () => ({ success: true });
  window.electronAPI.deleteTempFile = () => {};

  window.electronAPI.cancelUploadTranscription = async ({ requestId }: { requestId: string }) => {
    cancels.push(requestId);

    return { success: true, cancelled: 1 };
  };

  let resolveTranscription!: (value: unknown) => void;
  let capturedRequestId: string | undefined;
  (globalThis as GlobalWithMocks).__hangTranscription = {
    start: (requestId: string) => {
      capturedRequestId = requestId;

      return new Promise((resolve) => {
        resolveTranscription = resolve;
      });
    },
  };
  t.after(() => {
    delete (globalThis as GlobalWithMocks).__hangTranscription;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openh-batch-hard-cancel-",
    mockModules: {
      "/services/fileTranscription": `
        export async function transcribeFileWithSpeakers(_filePath, _cfg, _diarization, _duration, opts) {
          return globalThis.__hangTranscription.start(opts.requestId);
        }
      `,
      "/components/notes/shared": `
        export const DOWNLOAD_ERROR_KEYS = {};
        export function transcriptionErrorKey() { return null; }
      `,
      "/services/uploadNotes": `
        export async function saveUploadNote() {
          globalThis.__hangTranscription.savedNote = true;
          return { success: true, note: { id: 1 } };
        }
        export function uploadTitleFallback() { return "Uploaded note"; }
      `,
      "/stores/settingsStore": "export function getSettings() { return {}; }",
      "/stores/policyRules": "export function isTranscriptionContextAllowed() { return true; }",
      "/stores/policyStore": `
        export const usePolicyStore = { getState() { return {}; } };
      `,
    },
  });

  const { addFiles, processBatchQueue, cancelBatch, useBatchQueueStore } =
    (await vite.ssrLoadModule(
      "/stores/batchQueueStore.ts"
    )) as typeof import("../../src/stores/batchQueueStore.ts");

  addFiles([{ name: "interview.wav", path: "/tmp/interview.wav", sizeBytes: 1024 }]);
  processBatchQueue(
    {
      transcription: cfg(),
      folderId: null,
    },
    { enabled: false, localModelsReady: false, numSpeakers: null }
  );

  // Wait until the item is hanging inside its transcription call.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useBatchQueueStore.getState().queue[0].status, "transcribing");

  cancelBatch();

  // The typed cancel op received the in-flight item's requestId.
  assert.deepEqual(cancels, [capturedRequestId]);
  assert.ok(capturedRequestId, "the batch item generated a requestId");

  const [item] = useBatchQueueStore.getState().queue;
  assert.equal(item.status, "error");
  assert.equal(item.error, "batchCancelled");
  assert.equal(useBatchQueueStore.getState().isProcessing, false);

  // A late settlement must not resurrect the item or create a note.
  resolveTranscription({ success: true, text: "late" });
  await new Promise((resolve) => setImmediate(resolve));
  const [after] = useBatchQueueStore.getState().queue;
  assert.equal(after.status, "error");
  assert.equal(after.noteId, undefined);
  assert.equal((globalThis as GlobalWithMocks).__hangTranscription!.savedNote, undefined);
});

test("an old cancelled batch settling cannot steal the new batch's cancel slot", async (t: TestContext) => {
  // A-cancel → B-start → A-settles → B-cancel: B must still be hard-cancellable
  // after the cancelled A settles late; late A must not save a note either.
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const cancels: string[] = [];
  window.electronAPI.cancelUrlDownload = async () => ({ success: true });
  window.electronAPI.deleteTempFile = () => {};

  window.electronAPI.cancelUploadTranscription = async ({ requestId }: { requestId: string }) => {
    cancels.push(requestId);

    return { success: true, cancelled: 1 };
  };

  const calls: Array<{ id: string; resolve: (value: unknown) => void }> = [];
  (globalThis as GlobalWithMocks).__twoBatchTranscription = {
    // Returns the deferred itself so the test settles each execution explicitly.
    start(requestId: string) {
      let resolve!: (value: unknown) => void;

      const settled = new Promise((r) => {
        resolve = r;
      });

      calls.push({ id: requestId, resolve });

      return settled;
    },
  };
  t.after(() => {
    delete (globalThis as GlobalWithMocks).__twoBatchTranscription;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openh-batch-slot-steal-",
    mockModules: {
      "/services/fileTranscription": `
        export function transcribeFileWithSpeakers(_p, _cfg, _diar, _duration, opts) {
          return globalThis.__twoBatchTranscription.start(opts.requestId);
        }
      `,
      "/components/notes/shared": `
        export const DOWNLOAD_ERROR_KEYS = {};
        export function transcriptionErrorKey() { return null; }
      `,
      "/services/uploadNotes": `
        export async function saveUploadNote() {
          globalThis.__twoBatchTranscription.savedNote = true;
          return { success: true, note: { id: 1 } };
        }
        export function uploadTitleFallback() { return "Uploaded note"; }
      `,
      "/stores/settingsStore": "export function getSettings() { return {}; }",
      "/stores/policyRules": "export function isTranscriptionContextAllowed() { return true; }",
      "/stores/policyStore": `
        export const usePolicyStore = { getState() { return {}; } };
      `,
    },
  });

  const { addFiles, processBatchQueue, cancelBatch } = (await vite.ssrLoadModule(
    "/stores/batchQueueStore.ts"
  )) as typeof import("../../src/stores/batchQueueStore.ts");

  const opts = {
    transcription: cfg(),
    folderId: null,
  };

  const diarization = { enabled: false, localModelsReady: false, numSpeakers: null };

  addFiles([{ name: "first.wav", path: "/tmp/first.wav", sizeBytes: 100 }]);
  processBatchQueue(opts, diarization);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);

  cancelBatch();
  addFiles([{ name: "second.wav", path: "/tmp/second.wav", sizeBytes: 100 }]);
  processBatchQueue(opts, diarization);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2, "a new run starts after Cancel");

  // The cancelled A settles late, while B owns the active slot.
  calls[0].resolve({ success: false, code: "UPLOAD_CANCELLED" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // B's cancel must reach the transport: the late A settlement above must not
  // have cleared the slot B claimed.
  cancelBatch();
  assert.deepEqual(
    cancels,
    calls.map((call) => call.id)
  );
  assert.equal(
    (globalThis as GlobalWithMocks).__twoBatchTranscription!.savedNote,
    undefined,
    "late A saves no note"
  );
});
