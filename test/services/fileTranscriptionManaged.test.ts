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
