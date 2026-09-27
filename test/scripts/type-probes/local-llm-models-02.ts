// @probe-name "bridged result types reject untyped consumption"
// @probe-codes [2322]
// @probe-origin test/scripts/localLlmModelsTypeProbe.test.js
import type { LocalLlmModelsApi } from "./src/contracts/localLlmModels.ts";

declare const api: LocalLlmModelsApi;

async function main() {
  const models = await api.modelGetAll();
  // LocalLlmModelStatus guarantees known fields; reading isDownloaded as a
  // boolean[] must not compile.
  const broken: boolean[] = models[0].isDownloaded;
}
void main;
