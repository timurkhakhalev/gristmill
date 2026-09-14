// The renderer side of the issue #32 cancel fix: transcribeFile forwards the
// managed requestId into the BYOK call (it previously only reached the local
// route), and cancelBatch hard-cancels the current batch item's execution
// instead of only discarding its late result.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

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

test("transcribeFile passes the requestId to the BYOK handler", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openh-file-byok-request-id-",
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  let byokOptions;
  window.electronAPI.transcribeAudioFileByok = async (options) => {
    byokOptions = options;
    return { success: true, text: "direct" };
  };

  await transcribeFile("/tmp/audio.wav", cfg(), false, { requestId: "req-42" });
  assert.equal(byokOptions.requestId, "req-42");

  // Without managed cancellation (voice drafts, plain transcribeFile) the id
  // is simply absent — those flows register nothing.
  await transcribeFile("/tmp/audio.wav", cfg(), false);
  assert.equal(byokOptions.requestId, undefined);
});

test("cancelBatch hard-cancels the current item and discards its late result", async (t) => {
  const { window } = installBrowserGlobals(t);

  const cancels = [];
  window.electronAPI.cancelUrlDownload = async () => ({ success: true });
  window.electronAPI.deleteTempFile = () => {};
  window.electronAPI.cancelUploadTranscription = async ({ requestId }) => {
    cancels.push(requestId);
    return { success: true, cancelled: 1 };
  };

  let resolveTranscription;
  let capturedRequestId;
  globalThis.__hangTranscription = {
    start: (requestId) => {
      capturedRequestId = requestId;
      return new Promise((resolve) => {
        resolveTranscription = resolve;
      });
    },
  };
  t.after(() => {
    delete globalThis.__hangTranscription;
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
  const { addFiles, processBatchQueue, cancelBatch, useBatchQueueStore } = await vite.ssrLoadModule(
    "/stores/batchQueueStore.ts"
  );

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
  assert.equal(globalThis.__hangTranscription.savedNote, undefined);
});
