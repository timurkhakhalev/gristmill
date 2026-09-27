const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { listLocalTranscriptionModels } = require("../../src/helpers/localTranscriptionModels.ts");
const registry = require("../../src/models/modelRegistryData.json");

const managers = (downloaded: any) => ({
  whisperManager: { isModelDownloaded: (m: unknown) => downloaded.has(m) },
  parakeetManager: { isModelDownloaded: (m: unknown) => downloaded.has(m) },
});

test("lists every registry model with provider, download state, and the app's default", () => {
  const models = listLocalTranscriptionModels({
    ...managers(new Set(["base", "cohere-transcribe-03-2026"])),
    env: { LOCAL_TRANSCRIPTION_PROVIDER: "whisper", LOCAL_WHISPER_MODEL: "base" },
  });

  const whisperCount = Object.keys(registry.whisperModels).length;
  const sherpaCount = Object.keys(registry.parakeetModels).length;
  assert.equal(models.length, whisperCount + sherpaCount);

  const base = models.find((m: any) => m.model === "base");
  assert.deepEqual(base, { provider: "whisper", model: "base", downloaded: true, default: true });

  const cohere = models.find((m: any) => m.model === "cohere-transcribe-03-2026");
  assert.equal(cohere.provider, "cohere");
  assert.equal(cohere.downloaded, true);
  assert.equal(cohere.default, false);

  assert.equal(models.filter((m: any) => m.default).length, 1);
  assert.ok(models.some((m: any) => m.provider === "nvidia"));
});

test("a sherpa default is read from PARAKEET_MODEL, and cloud mode yields no default", () => {
  const withParakeet = listLocalTranscriptionModels({
    ...managers(new Set()),
    env: { LOCAL_TRANSCRIPTION_PROVIDER: "nvidia", PARAKEET_MODEL: "parakeet-tdt-0.6b-v3" },
  });
  assert.deepEqual(
    withParakeet.filter((m: any) => m.default).map((m: any) => m.model),
    ["parakeet-tdt-0.6b-v3"]
  );

  const cloudMode = listLocalTranscriptionModels({ ...managers(new Set()), env: {} });
  assert.equal(
    cloudMode.some((m: any) => m.default),
    false
  );
});
