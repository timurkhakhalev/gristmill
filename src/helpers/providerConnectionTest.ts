import { normalizeBaseUrl, getModelListBaseCandidates } from "../config/constants.mts";
import { isSecureHttpEndpoint } from "../utils/endpointPolicy.ts";

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

export interface HeaderMap {
  [name: string]: string;
}

export interface ResolvedProviderRequest {
  endpoint: string;
  endpoints: string[];
  headers: HeaderMap;
}

export interface ConnectionTestOutcome {
  success: boolean;
  errorCode?: string;
  error?: string;
  status?: number;
}

export interface EndpointMap {
  [provider: string]: string;
}

const ENDPOINTS: EndpointMap = {
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
  elevenlabs: "https://api.elevenlabs.io/v1/user",
  // AssemblyAI exposes no model list; listing transcripts is its 200-vs-401 probe.
  assemblyai: "https://api.assemblyai.com/v2/transcript?limit=1",
};

// These endpoints do not return an OpenAI-shaped model list. A 200 only
// verifies credentials; it does not prove access to a particular STT model.
const MODEL_LIST_UNVERIFIABLE: ReadonlySet<string> = new Set([
  "deepgram",
  "assemblyai",
  "elevenlabs",
]);

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

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

export function resolveProviderRequest(config: ProviderConnectionConfig): ResolvedProviderRequest {
  const provider = String(config?.provider || "").toLowerCase();
  const apiKey = isString(config?.apiKey) ? config.apiKey.trim() : "";
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

  const headers: HeaderMap = { Accept: "application/json" };

  if (apiKey) {
    if (provider === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "gemini") {
      headers["x-goog-api-key"] = apiKey;
    } else if (provider === "deepgram") {
      headers.Authorization = `Token ${apiKey}`;
    } else if (provider === "elevenlabs") {
      headers["xi-api-key"] = apiKey;
    } else if (provider === "assemblyai") {
      headers.Authorization = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  return { endpoint: endpoints[0], endpoints, headers };
}

// When several candidate endpoints fail, report the most actionable failure.
interface FailurePriority {
  credentialsRejected: number;
  providerStatus: number;
  modelNotFound: number;
  endpointNotFound: number;
  timeout: number;
  network: number;
}

const FAILURE_PRIORITY: FailurePriority = {
  credentialsRejected: 4,
  providerStatus: 3,
  modelNotFound: 2.5,
  endpointNotFound: 2,
  timeout: 1,
  network: 0,
};

function isFailureCode(value: string | undefined): value is keyof FailurePriority {
  return value !== undefined && value in FAILURE_PRIORITY;
}

function failurePriority(value: string | undefined): number {
  return isFailureCode(value) ? FAILURE_PRIORITY[value] : 0;
}

type FailureCandidate = Omit<ConnectionTestOutcome, "success">;

function pickFailure(current: FailureCandidate | null, next: FailureCandidate): FailureCandidate {
  if (!current) return next;

  return failurePriority(next.errorCode) > failurePriority(current.errorCode) ? next : current;
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

interface ModelEntry {
  id?: unknown;
  name?: unknown;
}

interface ModelListPayload {
  data?: unknown;
  models?: unknown;
}

export type ConnectionTestPayload = ModelListPayload | readonly unknown[];

export type ModelIdentifier = string | number | boolean | bigint;

function isIdentifier<T>(value: T): value is T & ModelIdentifier {
  const kind = typeof value;

  return kind === "string" || kind === "number" || kind === "boolean" || kind === "bigint";
}

function isModelEntry<T>(value: T): value is T & ModelEntry {
  return typeof value === "object" && value !== null;
}

function isModelListPayload<T>(value: T): value is T & ModelListPayload {
  return typeof value === "object" && value !== null;
}

// Mirrors `String(value || "")`: falsy values collapse to the empty string,
// scalars stringify, and objects keep their default tag.
function identifierText<T>(value: T): string {
  if (!value) return "";

  if (isIdentifier(value)) return String(value);

  return Object.prototype.toString.call(value);
}

// Mirrors the original map: a string passes through; an object contributes its
// `id` then `name`; any other primitive (or a missing id/name) becomes absent.
function modelIdentifierOf<T>(model: T) {
  if (isString(model)) return model;

  if (!isModelEntry(model)) return undefined;

  return model.id || model.name;
}

function normalizeModelId<T>(value: T): string {
  return identifierText(value)
    .trim()
    .replace(/^models\//i, "");
}

export function responseModelIds(payload: ConnectionTestPayload): string[] {
  const models: readonly unknown[] = Array.isArray(payload)
    ? payload
    : isModelListPayload(payload) && Array.isArray(payload.data)
      ? payload.data
      : isModelListPayload(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];

  return models.map(modelIdentifierOf).map(normalizeModelId).filter(Boolean);
}

export interface ConnectionTestResponse {
  ok: boolean;
  status: number;
  json?: Response["json"];
}

async function responseOffersModel(
  response: ConnectionTestResponse,
  model: string
): Promise<boolean> {
  if (!model) return true;

  try {
    const payload: unknown = response.json ? await response.json() : undefined;

    return responseModelIds(asModelListPayload(payload)).includes(normalizeModelId(model));
  } catch {
    return false;
  }
}

function asModelListPayload<T>(payload: T): ConnectionTestPayload {
  if (Array.isArray(payload)) return payload;

  if (isModelListPayload(payload)) return payload;

  return [];
}

interface NamedError {
  name?: unknown;
}

function isNamedError<T>(value: T): value is T & NamedError {
  return typeof value === "object" && value !== null;
}

function isAbortError<T>(value: T): boolean {
  return isNamedError(value) && isString(value.name) && value.name === "AbortError";
}

export type ConnectionTestFetch = (
  url: string,
  init?: RequestInit
) => Promise<ConnectionTestResponse>;

export async function testProviderConnection(
  config: ProviderConnectionConfig,
  fetchImpl: ConnectionTestFetch = fetch
): Promise<ConnectionTestOutcome> {
  let request;

  try {
    request = resolveProviderRequest(config);
  } catch (error) {
    return {
      success: false,
      errorCode: error instanceof ConnectionTestError ? error.errorCode : "invalidUrl",
      error: error instanceof Error ? error.message : String(error),
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
      if (isAbortError(error)) {
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
