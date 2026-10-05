const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness.ts");

import type { ViteDevServer } from "vite";

// Regression for the upload/URL-ingest path dropping diarization metadata: the
// batch queue ran the diarizer but persisted none of diarization_enabled,
// expected_speaker_count, or audio_duration_seconds, so an uploaded note that
// WAS diarized presented to the app as though it was not (the meeting path
// persists all of them).

const transcription = {
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  parakeetModel: "parakeet-tdt-0.6b-v3",
  isOpenWhisprCloud: false,
  getApiKey: () => "",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionBaseUrl: "",
  cloudTranscriptionModel: "whisper-1",
  language: "en",
};

const diarization = { enabled: true, localModelsReady: true, numSpeakers: 2 };

const gateMocks = {
  "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
  "./settingsStore": "export const getSettings = () => ({});",
  "./policyStore": "export const usePolicyStore = { getState: () => ({}) };",
  "./policyRules": "export const isTranscriptionContextAllowed = () => true;",
};

let vitePromise: Promise<ViteDevServer> | undefined;

const cleanup: Array<() => Promise<void>> = [];

test.after(async () => {
  for (const close of cleanup) await close();
});

async function getVite() {
  const vite = await (vitePromise ??= createRendererServer(
    { after: (close: () => Promise<void>) => cleanup.push(close) },
    {
      cachePrefix: "openwhispr-upload-diarization-test-",
      mockModules: gateMocks,
    }
  ));

  const module = await vite.moduleGraph.getModuleByUrl("/stores/batchQueueStore.ts");

  if (module) vite.moduleGraph.invalidateModule(module);

  return vite;
}

interface QueueItem {
  status: string;
  noteId?: number;
}

async function waitForQueueSettled(
  store: { getState: () => { queue: QueueItem[]; isProcessing: boolean } },
  timeoutMs = 5000
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { queue, isProcessing } = store.getState();

    if (!isProcessing && queue.every((i) => i.status === "done" || i.status === "error")) {
      return queue;
    }

    if (Date.now() > deadline) {
      throw new Error(`queue never settled: ${JSON.stringify(store.getState().queue)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type RendererWindow = { electronAPI: Record<string, unknown> };

function installUploadElectronAPI(
  window: RendererWindow,
  { diarizedDurationSeconds }: { diarizedDurationSeconds: number }
) {
  const calls = {
    saveNote: [] as unknown[][],
    updateNote: [] as Array<[number, Record<string, unknown>]>,
    diarize: [] as Array<Record<string, unknown>>,
    deletedTempFiles: [] as unknown[],
  };

  Object.assign(window.electronAPI, {
    transcribeAudioFile: async () => ({ success: true, text: "hello from the recording" }),
    diarizeAudioFile: async (_filePath: string, options: Record<string, unknown>) => {
      calls.diarize.push(options);

      return {
        success: true,
        segments: [
          { start: 0, end: 30, speaker: "Speaker 1" },
          { start: 30, end: 60, speaker: "Speaker 2" },
        ],
        durationSeconds: diarizedDurationSeconds,
      };
    },
    mergeSpeakerText: async () => ({ success: true, text: "[Speaker 1] hello [Speaker 2] hi" }),
    saveNote: async (...args: unknown[]) => {
      calls.saveNote.push(args);

      return { success: true, note: { id: 7 } };
    },
    updateNote: async (id: number, updates: Record<string, unknown>) => {
      calls.updateNote.push([id, updates]);

      return { success: true, note: { id } };
    },
    deleteTempFile: (path: string) => calls.deletedTempFiles.push(path),
    cancelUrlDownload: () => {},
  });

  return calls;
}

test("a diarized file upload persists the diarization metadata", async (t: import("node:test").TestContext) => {
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const vite = await getVite();
  // The renderer never knows a picked file's duration up front; the diarizer's
  // measured duration is the only source, so it must land on the note row.
  const calls = installUploadElectronAPI(window, { diarizedDurationSeconds: 4359.87 });

  const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  store.addFiles([{ name: "board-meeting.m4a", path: "/tmp/board-meeting.m4a", sizeBytes: 2048 }]);
  store.processBatchQueue({ transcription, folderId: null }, diarization);

  const queue = await waitForQueueSettled(store.useBatchQueueStore);
  assert.equal(queue[0].status, "done");
  assert.equal(queue[0].noteId, 7);

  assert.equal(calls.saveNote.length, 1);

  const [, content, noteType, sourceFile, audioDuration] = calls.saveNote[0] as [
    unknown,
    string,
    string,
    string,
    number,
  ];

  assert.equal(content, "[Speaker 1] hello [Speaker 2] hi");
  assert.equal(noteType, "upload");
  assert.equal(sourceFile, "board-meeting.m4a");
  assert.equal(audioDuration, 4359.87);

  // The persisted count is the same one the diarizer was invoked with.
  assert.equal(calls.diarize.length, 1);
  assert.equal(calls.diarize[0].numSpeakers, 2);
  // The diarizer runs under the same cancellable requestId as the
  // transcription, so one cancel-upload-transcription aborts both.
  assert.equal(typeof calls.diarize[0].requestId, "string");
  // saveUploadNote writes the timestamped transcript through updateNote and
  // moves the plain text out of the content column. The transcript timestamp
  // is Date.now()-anchored, so only its shape is asserted here.
  assert.deepEqual(
    calls.updateNote.map(([id, updates]) => {
      const { transcript, ...rest } = updates;

      return [id, rest, typeof transcript === "string" && transcript.includes("[Speaker 1] hello")];
    }),
    [[7, { diarization_enabled: 1, expected_speaker_count: 2, content: "" }, true]]
  );
});

test("a diarized URL ingest persists the diarization metadata", async (t: import("node:test").TestContext) => {
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const vite = await getVite();
  // The download's known duration beats the diarizer's measurement.
  const calls = installUploadElectronAPI(window, { diarizedDurationSeconds: 9999 });
  Object.assign(window.electronAPI, {
    onUrlDownloadProgress: () => () => {},
    downloadUrlAudio: async () => ({
      success: true,
      tempPath: "/tmp/ow-url-download.m4a",
      title: "Board Meeting Recording",
      sizeBytes: 4096,
      durationSeconds: 4359.87,
    }),
  });

  const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  store.addUrls(["https://www.youtube.com/watch?v=abc123"]);
  store.processBatchQueue({ transcription, folderId: null }, diarization);

  const queue = await waitForQueueSettled(store.useBatchQueueStore);
  assert.equal(queue[0].status, "done");

  assert.equal(calls.saveNote.length, 1);

  const [title, , noteType, sourceFile, audioDuration] = calls.saveNote[0] as [
    string,
    unknown,
    string,
    string,
    number,
  ];

  assert.equal(title, "Board Meeting Recording");
  assert.equal(noteType, "upload");
  assert.equal(sourceFile, "Board Meeting Recording");
  assert.equal(audioDuration, 4359.87);

  assert.deepEqual(
    calls.updateNote.map(([id, updates]) => {
      const { transcript, ...rest } = updates;

      return [id, rest, typeof transcript === "string" && transcript.includes("[Speaker 1] hello")];
    }),
    [[7, { diarization_enabled: 1, expected_speaker_count: 2, content: "" }, true]]
  );
  assert.deepEqual(calls.deletedTempFiles, ["/tmp/ow-url-download.m4a"]);
});

test("an upload without diarization leaves the note columns untouched", async (t: import("node:test").TestContext) => {
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const vite = await getVite();
  const calls = installUploadElectronAPI(window, { diarizedDurationSeconds: 4359.87 });

  const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  store.addFiles([{ name: "memo.m4a", path: "/tmp/memo.m4a", sizeBytes: 2048 }]);
  store.processBatchQueue(
    { transcription, folderId: null },
    { enabled: false, localModelsReady: true, numSpeakers: 2 }
  );

  const queue = await waitForQueueSettled(store.useBatchQueueStore);
  assert.equal(queue[0].status, "done");

  // diarization_enabled must stay null: consumers treat null as "use the
  // global speaker setting" when recording into the note later, and a stored 0
  // would force it off. The transcript write still happens (timestamps are on
  // for uploads), but it must not drag any diarization column with it.
  assert.equal(calls.diarize.length, 0);
  assert.equal(calls.updateNote.length, 1);
  assert.equal(calls.updateNote[0][0], 7);
  assert.equal(calls.updateNote[0][1].diarization_enabled, undefined);
  assert.equal(calls.updateNote[0][1].expected_speaker_count, undefined);
  assert.equal(calls.updateNote[0][1].content, "");
  assert.equal(calls.saveNote.length, 1);
  assert.equal(calls.saveNote[0][4], null);
});
