// @probe-name "download progress events carry discriminated types through the api"
// @probe-codes [2339]
// @probe-origin test/scripts/localModelLifecycleTypeProbe.test.js
import type { LocalModelLifecycleApi } from "./src/contracts/localModelLifecycle.ts";

declare const api: LocalModelLifecycleApi;

const dispose = api.onWhisperDownloadProgress((data) => {
  const pct: number | undefined = data.percentage;
  // "percent" is not a field of the event union.
  const bad: number = data.percent;
  void pct;
  void bad;
});
void dispose;
