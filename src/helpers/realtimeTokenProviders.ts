// Realtime STT token acquisition, one entry per provider. This is the explicit
// allowlist fetchRealtimeToken enforces: an unknown provider throws (fail-closed,
// #1480), and the callers that rely on it — meeting prepare/start and dictation
// streaming — resolve their provider ids in meetingTranscriptionRouting.ts and
// dictationStreamingRouting.js respectively. Dependencies are injected so the
// table is unit-testable without Electron.

export interface RealtimeTokenOptions {
  mode?: string;
  model?: string;
  language?: string;
  environment?: string;
  tenant?: string;
  keyterms?: readonly string[];
}

interface RealtimeEnvironmentManager {
  getOpenAIKey(): string | undefined;
  getTinfoilKey(): string | undefined;
  getDeepgramKey(): string | undefined;
  getAssemblyAIKey(): string | undefined;
  getGeminiKey(): string | undefined;
}

interface TokenResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface RealtimeTokenDependencies {
  environmentManager: RealtimeEnvironmentManager;
  proxyFetch(url: string, init: { headers: { Authorization: string } }): Promise<TokenResponse>;
  mintCortiToken(options: RealtimeTokenOptions): Promise<{ token: string }>;
}

export type RealtimeTokenResult = string | [string, string];

type TokenFactory = () => Promise<string>;
type TokenAcquirer = (
  deps: RealtimeTokenDependencies,
  options: RealtimeTokenOptions,
  streams?: number
) => Promise<RealtimeTokenResult>;

const getStringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
};

const dual = (streams: number | undefined, factory: TokenFactory) =>
  streams === 2 ? Promise.all([factory(), factory()]) : factory();
const duplicate = (streams: number | undefined, value: string): RealtimeTokenResult =>
  streams === 2 ? [value, value] : value;
const requireByok = (provider: string, options: RealtimeTokenOptions): void => {
  if (options.mode !== "byok") {
    throw new Error(`${provider} realtime requires a direct provider API key`);
  }
};

export const REALTIME_TOKEN_PROVIDERS = {
  "assemblyai-realtime": async ({ environmentManager, proxyFetch }, options, streams) => {
    requireByok("AssemblyAI", options);
    const apiKey = environmentManager.getAssemblyAIKey();
    if (!apiKey) {
      throw new Error("No AssemblyAI API key configured. Add your key in Settings.");
    }
    return dual(streams, async () => {
      const response = await proxyFetch(
        "https://streaming.assemblyai.com/v3/token?expires_in_seconds=60",
        { headers: { Authorization: apiKey } }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          getStringField(body, "error") || `AssemblyAI token request failed: ${response.status}`
        );
      }
      const data = await response.json();
      const token = getStringField(data, "token");
      if (!token) throw new Error("No AssemblyAI token received");
      return token;
    });
  },

  "deepgram-realtime": async ({ environmentManager }, options, streams) => {
    requireByok("Deepgram", options);
    const apiKey = environmentManager.getDeepgramKey();
    if (!apiKey) {
      throw new Error("No Deepgram API key configured. Add your key in Settings.");
    }
    return duplicate(streams, apiKey);
  },

  "gemini-realtime": async ({ environmentManager }, options, streams) => {
    requireByok("Gemini", options);
    const apiKey = environmentManager.getGeminiKey();
    if (!apiKey) {
      throw new Error("No Gemini API key configured. Add your key in Settings.");
    }
    // The raw key opens the Live socket directly and is not consumed by a
    // handshake, so both streams can share it.
    return duplicate(streams, apiKey);
  },

  "corti-realtime": async ({ mintCortiToken }, options, streams) => {
    // One token covers both meeting streams; it's only used at the WSS handshake.
    const { token } = await mintCortiToken(options);
    return duplicate(streams, token);
  },

  "tinfoil-realtime": async ({ environmentManager }, options, streams) => {
    const apiKey = environmentManager.getTinfoilKey();
    if (!apiKey) {
      const err = Object.assign(
        new Error("No Tinfoil API key configured. Add your key in Settings."),
        { code: "NO_API" }
      );
      throw err;
    }
    return duplicate(streams, apiKey);
  },

  "openai-realtime": async ({ environmentManager }, options, streams) => {
    requireByok("OpenAI", options);
    const apiKey = environmentManager.getOpenAIKey();
    if (!apiKey) throw new Error("No OpenAI API key configured. Add your key in Settings.");
    return duplicate(streams, apiKey);
  },
} satisfies Record<string, TokenAcquirer>;

export type RealtimeTokenProvider = keyof typeof REALTIME_TOKEN_PROVIDERS;

const isRealtimeTokenProvider = (provider: string): provider is RealtimeTokenProvider =>
  Object.hasOwn(REALTIME_TOKEN_PROVIDERS, provider);

export function fetchRealtimeTokenForProvider(
  provider: RealtimeTokenProvider,
  deps: RealtimeTokenDependencies,
  options?: RealtimeTokenOptions,
  request?: { streams?: 1 }
): Promise<string>;
export function fetchRealtimeTokenForProvider(
  provider: RealtimeTokenProvider,
  deps: RealtimeTokenDependencies,
  options: RealtimeTokenOptions | undefined,
  request: { streams: 2 }
): Promise<[string, string]>;
export async function fetchRealtimeTokenForProvider(
  provider: string | undefined,
  deps: RealtimeTokenDependencies,
  options: RealtimeTokenOptions = {},
  { streams }: { streams?: number } = {}
): Promise<RealtimeTokenResult> {
  // Property access on the former JS object coerced string-like keys. Keep
  // lookup and diagnostics on the same key instead of narrowing only one side.
  const providerKey = `${provider}`;
  if (!isRealtimeTokenProvider(providerKey)) {
    throw new Error(`Unsupported realtime token provider: ${providerKey}`);
  }
  return REALTIME_TOKEN_PROVIDERS[providerKey](deps, options, streams);
}

module.exports = {
  REALTIME_TOKEN_PROVIDERS,
  fetchRealtimeTokenForProvider,
};
