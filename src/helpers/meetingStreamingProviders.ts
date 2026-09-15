import { OpenAIRealtimeStreaming } from "./openaiRealtimeStreaming.js";
import { AssemblyAiStreaming } from "./assemblyAiStreaming.js";
import { DeepgramStreaming } from "./deepgramStreaming.js";
import { CortiStreaming } from "./cortiStreaming.js";
import { TinfoilRealtimeStreaming } from "./tinfoilRealtimeStreaming.js";

export interface MeetingStreamingConnectOptions {
  apiKey?: string | null;
  token?: string | null;
  model?: string | null;
  sampleRate?: number;
  inputRate?: number;
  captureRate?: number;
  language?: string | null;
  mode?: string;
  environment?: string | null;
  tenant?: string | null;
  keyterms?: readonly string[];
  streamLabel?: string | null;
  vadThreshold?: number;
}

export interface MeetingStreamingClient {
  isConnected: boolean;
  completedSegments: string[];
  audioBytesSent?: number;
  sessionStartedAt?: number | null;
  onPartialTranscript: ((text: string) => void) | null;
  onFinalTranscript: ((text: string, startedAt: number) => void) | null;
  onError: ((error: Error) => void) | null;
  onConnectionLost: ((error: Error) => void) | null;
  onSessionExpired?: ((event: { proactive?: boolean }) => void) | null;
  connect(options?: MeetingStreamingConnectOptions): Promise<void>;
  sendAudio(pcmBuffer: Buffer): boolean;
  disconnect(): Promise<{ text: string; audioDuration?: number }>;
}

export interface MeetingStreamingClientConstructor {
  new (): MeetingStreamingClient;
}

export interface MeetingConnectionOptions {
  provider?: string;
  model?: string;
  language?: string;
  mode?: string;
  environment?: string;
  tenant?: string;
  keyterms?: readonly string[];
}

export const STREAMING_CLIENT_BY_PROVIDER = {
  "openai-realtime": OpenAIRealtimeStreaming,
  "assemblyai-realtime": AssemblyAiStreaming,
  "deepgram-realtime": DeepgramStreaming,
  "corti-realtime": CortiStreaming,
  "tinfoil-realtime": TinfoilRealtimeStreaming,
} as const satisfies Record<string, MeetingStreamingClientConstructor>;

export type MeetingStreamingProvider = keyof typeof STREAMING_CLIENT_BY_PROVIDER;
export type AllowedMeetingProvider = "local" | MeetingStreamingProvider;

// Derived from the registry so an allowed provider can never lack a client
// class and silently fall through to the OpenAI default.
// SAFETY: Object.keys loses the finite key union even though the object cannot
// gain extra own keys between this call and construction of the Set.
const streamingProviders = Object.keys(STREAMING_CLIENT_BY_PROVIDER) as MeetingStreamingProvider[];
export const ALLOWED_MEETING_PROVIDERS: ReadonlySet<AllowedMeetingProvider> = new Set([
  "local",
  ...streamingProviders,
]);

const isMeetingStreamingProvider = (provider: string): provider is MeetingStreamingProvider =>
  Object.hasOwn(STREAMING_CLIENT_BY_PROVIDER, provider);

export function getMeetingStreamingClient(
  provider: MeetingStreamingProvider
): MeetingStreamingClientConstructor;
export function getMeetingStreamingClient(
  provider: string | undefined
): MeetingStreamingClientConstructor {
  // The former property lookup coerced string-like keys. Use the same value
  // for lookup and the fail-closed error so those semantics stay symmetric.
  const providerKey = `${provider}`;
  if (!isMeetingStreamingProvider(providerKey)) {
    throw new Error(`Unsupported meeting streaming provider: ${providerKey}`);
  }
  return STREAMING_CLIENT_BY_PROVIDER[providerKey];
}

export const getMeetingConnectionKey = (options: MeetingConnectionOptions = {}): string =>
  JSON.stringify({
    provider: options.provider,
    model: options.model,
    language: options.language,
    mode: options.mode,
    environment: options.environment,
    tenant: options.tenant,
    keyterms: options.keyterms,
  });

module.exports = {
  STREAMING_CLIENT_BY_PROVIDER,
  ALLOWED_MEETING_PROVIDERS,
  getMeetingStreamingClient,
  getMeetingConnectionKey,
};
