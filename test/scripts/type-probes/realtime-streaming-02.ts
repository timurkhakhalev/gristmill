// @probe-name "a two-stream token request cannot be consumed as one token"
// @probe-codes [2322]
// @probe-origin test/scripts/realtimeStreamingTypeProbe.test.js
import {
  fetchRealtimeTokenForProvider,
  type RealtimeTokenDependencies,
} from "./src/helpers/realtimeTokenProviders.ts";

declare const deps: RealtimeTokenDependencies;
async function main(): Promise<void> {
  const token: string = await fetchRealtimeTokenForProvider(
    "openai-realtime",
    deps,
    { mode: "byok" },
    { streams: 2 },
  );
  void token;
}
void main;
