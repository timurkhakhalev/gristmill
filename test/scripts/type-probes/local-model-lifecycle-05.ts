// @probe-name "the VAD wire config round-trips through the shared contract type"
// @probe-codes []
// @probe-origin issue-281 IPC/DTO boundary package
import type { LocalModelLifecycleApi } from "./src/contracts/localModelLifecycle.js";

declare const api: LocalModelLifecycleApi;

async function main() {
  const saved = await api.setWhisperVadConfig({ threshold: 0.5 });
  const got = await api.getWhisperVadConfig();

  // The sanitized merged view always carries the Silero toggles.
  const enabled: boolean | undefined = saved.config?.meetingSileroEnabled;
  const threshold: number | undefined = got.config?.threshold;
  void enabled;
  void threshold;
}
void main();
