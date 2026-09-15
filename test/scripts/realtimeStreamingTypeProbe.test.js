// Strict-mode probes for the realtime-client/token-routing cutover: the finite
// provider maps, dual-stream token result and full client graph must stay typed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "realtime-streaming-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((diagnostic) => diagnostic.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

test("Gemini cannot enter the finite meeting client registry", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { getMeetingStreamingClient } from "./src/helpers/meetingStreamingProviders.ts";
getMeetingStreamingClient("gemini-realtime");
`);
  assert.deepEqual(codes, [2345]);
  cleanup();
});

test("a two-stream token request cannot be consumed as one token", () => {
  const { codes, cleanup } = probeDiagnostics(`
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
`);
  assert.deepEqual(codes, [2322]);
  cleanup();
});

test("the meeting picker rejects a dictation-only provider id", () => {
  const { codes, cleanup } = probeDiagnostics(`
import type { MeetingStreamingProviderId } from "./src/helpers/meetingTranscriptionRouting.ts";
const provider: MeetingStreamingProviderId = "gemini";
void provider;
`);
  assert.deepEqual(codes, [2322]);
  cleanup();
});

test("the full realtime transport and routing graph compiles under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
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
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
