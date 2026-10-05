const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createRendererServer,
  installBrowserGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

// The upload flows opt into segment timestamps (issue #1095): the flag must
// reach the BYOK IPC call, and the segments the handler returns must survive
// transcribeFileWithSpeakers' result spread so saveUploadNote can persist them.

function byokConfig() {
  return {
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    isOpenWhisprCloud: false,
    getApiKey: () => "sk-test",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "whisper-1",
    language: "en",
    transcriptionMode: "providers",
  };
}

test("timestamps opt-in reaches the BYOK IPC call and segments flow back", async (t: import("node:test").TestContext) => {
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-timestamps-test-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });

  const { transcribeFile, transcribeFileWithSpeakers } = await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  );

  const segments = [{ text: "Hello.", start: 0, end: 2.5 }];
  let receivedOptions: Record<string, unknown> | null = null;
  window.electronAPI.transcribeAudioFileByok = async (options: Record<string, unknown>) => {
    receivedOptions = options;

    return { success: true, text: "Hello.", segments };
  };

  const direct = await transcribeFile("/tmp/audio.webm", byokConfig(), false, {
    timestamps: true,
  });

  assert.equal(receivedOptions!.timestamps, true);
  assert.deepEqual(direct.segments, segments);

  // Without the opt-in the request stays exactly as before.
  await transcribeFile("/tmp/audio.webm", byokConfig(), false);
  assert.equal(receivedOptions!.timestamps, undefined);

  const withSpeakers = await transcribeFileWithSpeakers(
    "/tmp/audio.webm",
    byokConfig(),
    { enabled: false, localModelsReady: false, numSpeakers: null },
    120,
    { timestamps: true }
  );

  assert.equal(receivedOptions!.timestamps, true);
  assert.deepEqual(withSpeakers.segments, segments);
  assert.equal(withSpeakers.durationSeconds, 120);
});
