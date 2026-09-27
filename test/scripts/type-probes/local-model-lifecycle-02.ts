// @probe-name "bridged result types reject untyped consumption"
// @probe-codes [2322]
// @probe-origin test/scripts/localModelLifecycleTypeProbe.test.js
import type { LocalModelLifecycleApi } from "./src/contracts/localModelLifecycle.ts";

declare const api: LocalModelLifecycleApi;

async function main() {
  const status = await api.listWhisperModels();
  // LocalModelListResult only guarantees success/models/cache_dir + index
  // access; reading a model row as a boolean must not compile.
  const broken: boolean = status.models;
}
void main;
