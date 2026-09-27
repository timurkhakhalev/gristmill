// @probe-name "the full realtime transport and routing graph compiles under strict settings"
// @probe-codes []
// @probe-origin test/scripts/realtimeStreamingTypeProbe.test.js
import { OpenAIRealtimeStreaming } from "./src/helpers/openaiRealtimeStreaming.ts";
import { AssemblyAiStreaming } from "./src/helpers/assemblyAiStreaming.ts";
import { DeepgramStreaming } from "./src/helpers/deepgramStreaming.ts";
import { CortiStreaming } from "./src/helpers/cortiStreaming.ts";
import { TinfoilRealtimeStreaming } from "./src/helpers/tinfoilRealtimeStreaming.ts";
import { GeminiLiveStreaming } from "./src/helpers/geminiLiveStreaming.ts";
import {
  getMeetingConnectionKey,
  getMeetingStreamingClient,
  type MeetingStreamingClient,
} from "./src/helpers/meetingStreamingProviders.ts";
import {
  fetchRealtimeTokenForProvider,
  type RealtimeTokenDependencies,
} from "./src/helpers/realtimeTokenProviders.ts";
import {
  filterMeetingStreamingProviders,
  resolveMeetingTranscriptionOptions,
} from "./src/helpers/meetingTranscriptionRouting.ts";

const clients: MeetingStreamingClient[] = [
  new OpenAIRealtimeStreaming(),
  new AssemblyAiStreaming(),
  new DeepgramStreaming(),
  new CortiStreaming(),
  new TinfoilRealtimeStreaming(),
  new GeminiLiveStreaming(),
  new (getMeetingStreamingClient("tinfoil-realtime"))(),
];
for (const client of clients) {
  client.onFinalTranscript = (text, startedAt) => void [text, startedAt];
  void client.sendAudio(Buffer.alloc(2));
}

const deps: RealtimeTokenDependencies = {
  environmentManager: {
    getOpenAIKey: () => "openai",
    getTinfoilKey: () => "tinfoil",
    getDeepgramKey: () => "deepgram",
    getAssemblyAIKey: () => "assembly",
    getGeminiKey: () => "gemini",
  },
  proxyFetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ token: "assembly" }),
  }),
  mintCortiToken: async () => ({ token: "corti" }),
};

async function useTokens(): Promise<void> {
  const one: string = await fetchRealtimeTokenForProvider(
    "openai-realtime",
    deps,
    { mode: "byok" },
  );
  const two: [string, string] = await fetchRealtimeTokenForProvider(
    "assemblyai-realtime",
    deps,
    { mode: "byok" },
    { streams: 2 },
  );
  void [one, two];
}
void useTokens;

void getMeetingConnectionKey({
  provider: "corti-realtime",
  model: "corti-transcribe",
  language: "en",
  mode: "byok",
  environment: "us",
  tenant: "tenant",
  keyterms: ["OpenHercules"],
});
void filterMeetingStreamingProviders([
  { id: "openai", models: [{ id: "gpt-4o-mini-transcribe" }] },
  { id: "gemini", models: [{ id: "gemini-3.5-transcribe-live" }] },
]);
void resolveMeetingTranscriptionOptions({
  transcriptionMode: "providers",
  language: "en",
  localProvider: "whisper",
  selectedProvider: "openai",
  byokProviders: [{ id: "openai", models: [{ id: "gpt-4o-mini-transcribe" }] }],
});
