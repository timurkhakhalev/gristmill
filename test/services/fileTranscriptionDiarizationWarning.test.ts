const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness.ts");

let vitePromise: Promise<import("vite").ViteDevServer> | undefined;

const cleanup: Array<() => Promise<void>> = [];

test.after(async () => {
  for (const close of cleanup) await close();
});

function getVite() {
  return (vitePromise ??= createRendererServer(
    { after: (close: () => Promise<void>) => cleanup.push(close) },
    {
      cachePrefix: "openwhispr-file-diarization-warning-test-",
      mockModules: {
        "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      },
    }
  ));
}

function localConfig() {
  return {
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    cohereModel: "command-a-transcribe",
    isOpenWhisprCloud: false,
    getApiKey: () => "",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "whisper-1",
    language: "en",
    transcriptionMode: "providers",
  };
}

async function loadFileTranscription(t: import("node:test").TestContext) {
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const vite = await getVite();
  const module = await vite.moduleGraph.getModuleByUrl("/services/fileTranscription.ts");

  if (module) vite.moduleGraph.invalidateModule(module);

  const mod = (await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  )) as typeof import("../../src/services/fileTranscription.ts");

  window.electronAPI.transcribeAudioFile = async () => ({
    success: true,
    text: "Plain transcript",
  });

  return { window, ...mod };
}

test("keeps the transcript and warns when local speaker identification fails", async (t: import("node:test").TestContext) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.diarizeAudioFile = async (): Promise<{
    success: boolean;
    error?: string;
    segments?: unknown[];
  }> => ({
    success: false,
    error: "Speaker identification failed",
  });

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(result.success, true);
  assert.equal(result.text, "Plain transcript");
  assert.equal(result.diarizationWarning, true);
});

test("keeps the transcript and warns when speaker labels cannot be merged", async (t: import("node:test").TestContext) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.diarizeAudioFile = async (): Promise<{
    success: boolean;
    error?: string;
    segments?: unknown[];
  }> => ({
    success: true,
    segments: [{ speaker: "speaker_00", start: 0, end: 2 }],
  });
  window.electronAPI.mergeSpeakerText = async () => ({
    success: false,
    error: "Merge failed",
  });

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(result.success, true);
  assert.equal(result.text, "Plain transcript");
  assert.equal(result.diarizationWarning, true);
});

test("does not warn when speaker labels are merged", async (t: import("node:test").TestContext) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.diarizeAudioFile = async (): Promise<{
    success: boolean;
    error?: string;
    segments?: unknown[];
  }> => ({
    success: true,
    segments: [{ speaker: "speaker_00", start: 0, end: 2 }],
  });
  window.electronAPI.mergeSpeakerText = async () => ({
    success: true,
    text: "Speaker 1: Plain transcript",
  });

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(result.text, "Speaker 1: Plain transcript");
  assert.equal(result.diarizationWarning, undefined);
});

test("does not warn when speaker detection is off", async (t: import("node:test").TestContext) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  let diarizeCalls = 0;
  window.electronAPI.diarizeAudioFile = async (): Promise<{
    success: boolean;
    error?: string;
    segments?: unknown[];
  }> => {
    diarizeCalls += 1;

    return { success: false };
  };

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: false,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(diarizeCalls, 0);
  assert.equal(result.diarizationWarning, undefined);
});

test("does not warn when the provider applied its own speaker labels", async (t: import("node:test").TestContext) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.transcribeAudioFile = async () => ({
    success: true,
    text: "[Speaker 1] Hola",
    diarized: true,
  });

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(result.diarizationWarning, undefined);
});

test("keeps the transcript and warns when the merge throws", async (t: import("node:test").TestContext) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.diarizeAudioFile = async (): Promise<{
    success: boolean;
    error?: string;
    segments?: unknown[];
  }> => ({
    success: true,
    segments: [{ speaker: "speaker_00", start: 0, end: 2 }],
  });
  window.electronAPI.mergeSpeakerText = async () => {
    throw new Error("merge crashed");
  };

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(result.text, "Plain transcript");
  assert.equal(result.diarizationWarning, true);
});

test("fetches the local speaker models before a run that needs them", async (t: import("node:test").TestContext) => {
  const { resolveDiarizationSettings } = await loadFileTranscription(t);
  let ensureCalls = 0;

  const settings = await resolveDiarizationSettings({
    enabled: true,
    modelsReady: false,
    numSpeakers: null,
    config: localConfig(),
    ensureModels: async () => {
      ensureCalls += 1;

      return true;
    },
  });

  assert.equal(ensureCalls, 1);
  assert.deepEqual(settings, { enabled: true, localModelsReady: true, numSpeakers: null });
});

test("does not fetch local models when file providers diarize server-side", async (t: import("node:test").TestContext) => {
  const { resolveDiarizationSettings } = await loadFileTranscription(t);
  let ensureCalls = 0;

  for (const provider of ["deepgram", "elevenlabs", "gemini"]) {
    const settings = await resolveDiarizationSettings({
      enabled: true,
      modelsReady: false,
      numSpeakers: 2,
      config: { ...localConfig(), useLocalWhisper: false, cloudTranscriptionProvider: provider },
      ensureModels: async () => {
        ensureCalls += 1;

        return true;
      },
    });

    assert.deepEqual(settings, { enabled: true, localModelsReady: false, numSpeakers: 2 });
  }

  assert.equal(ensureCalls, 0);
});

test("does not fetch local models when speaker detection is off", async (t: import("node:test").TestContext) => {
  const { resolveDiarizationSettings } = await loadFileTranscription(t);
  let ensureCalls = 0;

  const settings = await resolveDiarizationSettings({
    enabled: false,
    modelsReady: false,
    numSpeakers: null,
    config: localConfig(),
    ensureModels: async () => {
      ensureCalls += 1;

      return true;
    },
  });

  assert.equal(ensureCalls, 0);
  assert.equal(settings.enabled, false);
});

test("reports models unavailable when the download fails", async (t: import("node:test").TestContext) => {
  const { resolveDiarizationSettings } = await loadFileTranscription(t);

  const settings = await resolveDiarizationSettings({
    enabled: true,
    modelsReady: false,
    numSpeakers: null,
    config: localConfig(),
    ensureModels: async () => false,
  });

  assert.equal(settings.localModelsReady, false);
});
