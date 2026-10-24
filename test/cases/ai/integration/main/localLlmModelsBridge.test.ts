const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  loadBundledPreload,
  plain,
}: typeof import("../../../../helpers/harness/bundledPreload.ts") = require("../../../../helpers/harness/bundledPreload.ts");
const catalog: typeof import("../../../../../src/models/modelRegistryData.json") = require("../../../../../src/models/modelRegistryData.json");
const {
  LocalModelDownloadStatus,
}: typeof import("../../../../../src/helpers/localModelDownloadStatus.ts") = require("../../../../../src/helpers/localModelDownloadStatus.ts");
import type { LocalLlmModelsApi, LocalLlmModelStatus } from "../../../../../src/contracts/localLlmModels.ts";

function bridgeFor(raw: unknown): LocalLlmModelsApi {
  return loadBundledPreload<LocalLlmModelsApi>({ invoke: async () => raw });
}

const models: LocalLlmModelStatus[] = catalog.localProviders.flatMap((provider) =>
  provider.models.map((model) => ({
    ...model,
    providerId: provider.id,
    providerName: provider.name,
    isDownloaded: true,
    isDownloading: false,
    downloadProgress: 0,
    downloadedSize: 0,
    totalSize: 0,
    path: `/synthetic-models/${model.fileName}`,
  }))
);

test("bundled preload accepts the complete catalog with download status", async () => {
  assert.deepEqual(plain(await bridgeFor(models).modelGetAll()), models);
});

test("bundled preload accepts tracker snapshots for every download type", async () => {
  const tracker = new LocalModelDownloadStatus();
  for (const type of ["whisper", "parakeet", "llm"]) tracker.start(type, `synthetic-${type}`);
  tracker.update("parakeet", "synthetic-parakeet", { phase: "installing", progress: 50 });
  const rows = tracker.getActiveDownloads();
  assert.deepEqual(plain(await bridgeFor(rows).modelGetActiveDownloads()), rows);
});

test("empty model and download lists are valid", async () => {
  const api = bridgeFor([]);
  assert.deepEqual(plain(await api.modelGetAll()), []);
  assert.deepEqual(plain(await api.modelGetActiveDownloads()), []);
});

test("nullable paths and absent optional catalog fields are valid", async () => {
  const {
    descriptionKey, recommended, supportsThinking, draftHfRepo, draftFileName, draftSizeBytes,
    ...required
  } = models[0];
  const rows = [{ ...required, isDownloaded: false, path: null }];
  assert.deepEqual(plain(await bridgeFor(rows).modelGetAll()), rows);
});

test("malformed lists reject the entire response with its channel", async () => {
  const tracker = new LocalModelDownloadStatus();
  const download = tracker.start("llm", "synthetic-model");
  for (const raw of [null, {}, "invalid", [null], [[]], [{}]]) {
    await assert.rejects(bridgeFor(raw).modelGetAll(), /Unexpected response shape from model-get-all/);
    await assert.rejects(bridgeFor(raw).modelGetActiveDownloads(), /Unexpected response shape from model-get-active-downloads/);
  }
  for (const invalid of [
    { ...models[0], id: 5 },
    { ...models[0], isDownloaded: "true" },
    { ...models[0], path: undefined },
    { ...models[0], recommended: "yes" },
  ]) {
    await assert.rejects(bridgeFor([models[0], invalid]).modelGetAll(), /model-get-all/);
  }
  for (const invalid of [
    { ...download, modelType: "other" },
    { ...download, phase: "complete" },
    { ...download, sequence: undefined },
    { ...download, progress: "50" },
  ]) {
    await assert.rejects(bridgeFor([download, invalid]).modelGetActiveDownloads(), /model-get-active-downloads/);
  }
});

test("object results and IPC failures retain their behavior", async () => {
  const result = { success: true, path: "/synthetic-models/example.gguf" };
  assert.deepEqual(plain(await bridgeFor(result).modelDownload("synthetic-model")), result);
  const error = new Error("Synthetic transport failure");
  const api = loadBundledPreload<LocalLlmModelsApi>({ invoke: async () => { throw error; } });
  await assert.rejects(api.modelGetAll(), (cause: unknown) => cause === error);
  await assert.rejects(api.modelGetActiveDownloads(), (cause: unknown) => cause === error);
});
