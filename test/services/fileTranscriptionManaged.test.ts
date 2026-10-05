const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createRendererServer,
  installBrowserGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

const cfg = (overrides: Record<string, unknown> = {}) => ({
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

test("file transcription never dispatches an OpenWhispr cloud route", async (t: import("node:test").TestContext) => {
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openh-file-direct-routing-",
  });

  const { transcribeFile } = (await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  )) as typeof import("../../src/services/fileTranscription.ts");

  let cloudCalls = 0;
  let byokOptions: Record<string, unknown> | undefined;
  window.electronAPI.transcribeAudioFileCloud = async () => {
    cloudCalls += 1;

    return { success: true, text: "cloud" };
  };

  window.electronAPI.transcribeAudioFileByok = async (options: Record<string, unknown>) => {
    byokOptions = options;

    return { success: true, text: "direct" };
  };

  // The legacy flag is deliberately ignored. A direct provider route is the
  // only upload dispatch left after the managed lane is removed.
  const result = await transcribeFile("/tmp/audio.wav", cfg({ isOpenWhisprCloud: true }), false);

  assert.equal(result.text, "direct");
  assert.equal(cloudCalls, 0);
  assert.equal(byokOptions!.provider, "openai");
});

test("enterprise transcription fails closed instead of using organization routing", async (t: import("node:test").TestContext) => {
  const { window } = installBrowserGlobals(t) as {
    window: { electronAPI: Record<string, unknown> };
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openh-file-enterprise-routing-",
  });

  const { transcribeFile } = (await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  )) as typeof import("../../src/services/fileTranscription.ts");

  let calls = 0;
  window.electronAPI.transcribeAudioFileByok = async () => {
    calls += 1;

    return { success: true, text: "must-not-run" };
  };

  const result = await transcribeFile(
    "/tmp/audio.wav",
    cfg({ transcriptionMode: "enterprise" }),
    false
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "UNSUPPORTED_TRANSCRIPTION_MODE");
  assert.equal(calls, 0);
});
