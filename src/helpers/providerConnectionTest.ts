import { normalizeBaseUrl, getModelListBaseCandidates } from "../config/constants.mts";
import { isSecureHttpEndpoint } from "../utils/urlUtils.ts";

export interface ProviderConnectionConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  environment?: string;
  tenant?: string;
}

export interface ResolvedProviderRequest {
  endpoint: string;
  endpoints: string[];
  headers: Record<string, string>;
}

export interface ConnectionTestOutcome {
  success: boolean;
  errorCode?: string;
  error?: string;
  status?: number;
}

const ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
  xai: "https://api.x.ai/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  openrouter: "https://openrouter.ai/api/v1/models",
  corti: "https://ai.eu.corti.app/v1/models",
  tinfoil: "https://inference.tinfoil.sh/v1/models",
  deepgram: "https://api.deepgram.com/v1/models",
  // AssemblyAI exposes no model list; listing transcripts is its 200-vs-401 probe.
  assemblyai: "https://api.assemblyai.com/v2/transcript?limit=1",
};

// Neither response is OpenAI-shaped — Deepgram's /v1/models is {stt,tts}-keyed
// and AssemblyAI returns transcripts — so a 200 is the whole credential signal.
const MODEL_LIST_UNVERIFIABLE: ReadonlySet<string> = new Set(["deepgram", "assemblyai"]);

// Renderers translate errorCode via onboarding.rehaul.provider.errors.*; the
// English `error` string stays for logs and older callers.
class ConnectionTestError extends Error {
  constructor(
    readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}

function buildModelEndpoints(base: string): string[] {
  return getModelListBaseCandidates(base).map((candidate) => `${candidate}/models`);
}

export function resolveProviderRequest(config: ProviderConnectionConfig): ResolvedProviderRequest {
  const provider = String(config?.provider || "").toLowerCase();
  const apiKey = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  const knownEndpoint = ENDPOINTS[provider];
  let endpoints: string[] = knownEndpoint ? [knownEndpoint] : [];

  if (provider === "openai") {
    const override = normalizeBaseUrl(process.env.OPENAI_BASE_URL);
    if (override) endpoints = buildModelEndpoints(override);
  }

  if (provider === "custom") {
    const raw = String(config?.baseUrl || "").trim();
    if (!raw) {
      throw new ConnectionTestError("endpointRequired", "Enter an endpoint URL before testing.");
    }
    let parsed;
    try {
      parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    } catch {
      throw new ConnectionTestError("invalidUrl", "The endpoint must be a valid URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ConnectionTestError("invalidUrl", "The endpoint must use HTTP or HTTPS.");
    }
    if (!isSecureHttpEndpoint(parsed.toString())) {
      throw new ConnectionTestError(
        "httpsRequired",
        "Public endpoints must use HTTPS. HTTP is only allowed on private addresses."
      );
    }
    endpoints = buildModelEndpoints(parsed.toString());
  }

  if (endpoints.length === 0) {
    throw new ConnectionTestError(
      "unsupportedProvider",
      "Connection testing is not available for this provider."
    );
  }
  if (!apiKey && provider !== "custom") {
    throw new ConnectionTestError("apiKeyRequired", "Add an API key before testing.");
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    if (provider === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "gemini") {
      headers["x-goog-api-key"] = apiKey;
    } else if (provider === "deepgram") {
      headers.Authorization = `Token ${apiKey}`;
    } else if (provider === "assemblyai") {
      headers.Authorization = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  return { endpoint: endpoints[0], endpoints, headers };
}

// When several candidate endpoints fail, report the most actionable failure.
const FAILURE_PRIORITY: Record<string, number> = {
  credentialsRejected: 4,
  providerStatus: 3,
  modelNotFound: 2.5,
  endpointNotFound: 2,
  timeout: 1,
  network: 0,
};

type FailureCandidate = Omit<ConnectionTestOutcome, "success">;

function pickFailure(current: FailureCandidate | null, next: FailureCandidate): FailureCandidate {
  if (!current) return next;
  return FAILURE_PRIORITY[next.errorCode as string] > FAILURE_PRIORITY[current.errorCode as string]
    ? next
    : current;
}

function describeStatusFailure(status: number, provider: string): FailureCandidate {
  if (status === 401 || status === 403) {
    return {
      errorCode: "credentialsRejected",
      error: "The provider rejected these credentials.",
      status,
    };
  }
  if (status === 404 && provider === "custom") {
    return {
      errorCode: "endpointNotFound",
      error: "The endpoint does not expose an OpenAI-compatible model list.",
      status,
    };
  }
  return { errorCode: "providerStatus", error: `The provider returned status ${status}.`, status };
}

function normalizeModelId(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^models\//i, "");
}

function responseModelIds(payload: unknown): string[] {
  const record = payload as
    | { data?: unknown; models?: unknown }
    | Array<unknown>
    | null
    | undefined;
  const models = Array.isArray(payload)
    ? payload
    : Array.isArray(record && !Array.isArray(record) ? record.data : undefined)
      ? ((record as { data: unknown[] }).data)
      : Array.isArray(record && !Array.isArray(record) ? record.models : undefined)
        ? ((record as { models: unknown[] }).models)
        : [];

  return models
    .map((model) =>
      typeof model === "string"
        ? model
        : ((model as { id?: unknown; name?: unknown })?.id as string | undefined) ||
          ((model as { name?: unknown })?.name as string | undefined)
    )
    .map(normalizeModelId)
    .filter(Boolean);
}

async function responseOffersModel(
  response: { json(): Promise<unknown> },
  model: string
): Promise<boolean> {
  if (!model) return true;
  try {
    const payload = await response.json();
    return responseModelIds(payload).includes(normalizeModelId(model));
  } catch {
    return false;
  }
}

export type ConnectionTestFetch = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export async function testProviderConnection(
  config: ProviderConnectionConfig,
  fetchImpl: ConnectionTestFetch = fetch as ConnectionTestFetch
): Promise<ConnectionTestOutcome> {
  let request;
  try {
    request = resolveProviderRequest(config);
  } catch (error) {
    return {
      success: false,
      errorCode: (error as ConnectionTestError).errorCode || "invalidUrl",
      error: (error as Error).message,
    };
  }

  const provider = String(config?.provider || "").toLowerCase();
  const model = String(config?.model || "").trim();
  let failure: FailureCandidate | null = null;
  for (const endpoint of request.endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: request.headers,
        signal: controller.signal,
      });
      if (response.ok) {
        if (MODEL_LIST_UNVERIFIABLE.has(provider)) return { success: true };
        if (await responseOffersModel(response, model)) return { success: true };
        failure = pickFailure(failure, {
          errorCode: "modelNotFound",
          error: "The selected model is not available from this provider.",
        });
        continue;
      }
      failure = pickFailure(failure, describeStatusFailure(response.status, provider));
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") {
        failure = pickFailure(failure, {
          errorCode: "timeout",
          error: "The connection test timed out.",
        });
      } else {
        failure = pickFailure(failure, {
          errorCode: "network",
          error: "The provider could not be reached.",
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  return { success: false, ...(failure || {}) };
}
