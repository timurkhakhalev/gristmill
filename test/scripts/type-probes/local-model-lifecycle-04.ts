// @probe-name "an unparseable VAD wire config is rejected at compile time"
// @probe-codes [2339]
// @probe-origin issue-281 IPC/DTO boundary package
import type { WhisperVadResult } from "./src/contracts/localModelLifecycle.js";

declare const result: WhisperVadResult;

async function read() {
  const config = result.config;

  // The wire config is the six numeric keys plus the Silero toggles; reading
  // a never-produced key must not compile.
  const bad: number | undefined = config?.thresholdScale;
  void bad;
}
void read();
