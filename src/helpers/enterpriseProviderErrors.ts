import { classifyNetworkError } from "./networkErrors.js";
/**
 * Maps enterprise provider errors to user-actionable messages.
 * Each mapped error includes a human-readable message and optionally
 * an action hint and a shell command the user can copy-paste.
 */

export interface MappedEnterpriseError {
  message: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  action?: string;
  actionKey?: string;
  copyCommand?: string;
  retryable?: boolean;
  technicalDetails?: {
    status?: number;
    exceptionType?: string;
    requestId?: string;
    underlyingError?: string;
  };
}

export type EnterpriseProvider = "bedrock" | "azure" | "vertex";

const BEDROCK_MAX_ATTEMPTS = 6;

const BEDROCK_INITIAL_DELAY_MS = 500;

const BEDROCK_MAX_DELAY_MS = 8_000;

const BEDROCK_SAFE_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// The error shapes external SDKs (AWS/AI SDK, Azure, Vertex) actually carry:
// any of these fields may be present, so each is read through a guard. A named
// interface with fixed keys is a contract, not an open dictionary.
export interface ErrorRecord {
  message?: unknown;
  code?: unknown;
  name?: unknown;
  type?: unknown;
  __type?: unknown;
  status?: unknown;
  statusCode?: unknown;
  httpStatusCode?: unknown;
  requestId?: unknown;
  $metadata?: unknown;
  response?: unknown;
  responseHeaders?: unknown;
  headers?: unknown;
  data?: unknown;
  lastError?: unknown;
  cause?: unknown;
  toString?(): string;
}

interface HeaderGetter {
  get(name: string): string | null | undefined;
}

interface HeaderBag {
  [name: string]: string | undefined;
}

// Provider config reaches the mappers as filenames/regions; each field is
// optional and read through a guard. `model`/`timeoutMs` are listed so callers
// passing the IPC connection config share a key with this contract.
export interface EnterpriseProviderConfig {
  bedrockRegion?: unknown;
  bedrockProfile?: unknown;
  bedrockAccessKeyId?: unknown;
  bedrockSecretAccessKey?: unknown;
  bedrockSessionToken?: unknown;
  azureEndpoint?: unknown;
  azureApiVersion?: unknown;
  vertexProject?: unknown;
  vertexLocation?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
}

// The credential subset the SDK factories consume, normalized to strings by
// `pickEnterpriseConfig` (see the reasoning runtime's `enterprise` field).
export interface EnterpriseRuntimeConfig {
  bedrockRegion?: string;
  bedrockProfile?: string;
  bedrockAccessKeyId?: string;
  bedrockSecretAccessKey?: string;
  bedrockSessionToken?: string;
  azureEndpoint?: string;
  azureApiVersion?: string;
  vertexProject?: string;
  vertexLocation?: string;
}

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

function isNumber<T>(value: T): value is T & number {
  return typeof value === "number";
}

function isInteger<T>(value: T): value is T & number {
  return typeof value === "number" && Number.isInteger(value);
}

function isScalar<T>(value: T): value is T & (string | number | boolean | bigint | symbol) {
  const kind = typeof value;

  return (
    kind === "string" ||
    kind === "number" ||
    kind === "boolean" ||
    kind === "bigint" ||
    kind === "symbol"
  );
}

function isErrorRecord<T>(value: T): value is T & ErrorRecord {
  return typeof value === "object" && value !== null;
}

function isObjectValue<T>(value: T): value is T & object {
  return typeof value === "object" && value !== null;
}

function isHeaderBag<T>(value: T): value is T & HeaderBag {
  return typeof value === "object" && value !== null;
}

function isHeaderGetter<T>(value: T): value is T & HeaderGetter {
  if (!isObjectValue(value)) return false;

  return "get" in value && typeof value.get === "function";
}

function asErrorRecord<T>(value: T): ErrorRecord | null {
  return isErrorRecord(value) ? value : null;
}

function stringifyScalar<T>(value: T): string {
  return isScalar(value) ? String(value) : "";
}

function runtimeString<T>(value: T): string {
  if (value instanceof Error) return String(value);

  if (value === null) return "null";

  if (value === undefined) return "undefined";

  if (isScalar(value)) return String(value);

  return String(asErrorRecord(value));
}

function messageOrRuntime<T>(record: ErrorRecord | null, fallback: T): string {
  const message = record?.message;

  return message ? runtimeString(message) : runtimeString(fallback);
}

function messageThenCode<T>(record: ErrorRecord | null, fallback: T): string {
  const message = record?.message;

  if (message) return runtimeString(message);
  const code = record?.code;

  if (code) return runtimeString(code);

  return runtimeString(fallback);
}

function firstPresentThenTruthy<T>(record: ErrorRecord | null, fallback: T): string {
  const combined = record?.message ?? record?.code;

  return combined ? runtimeString(combined) : runtimeString(fallback);
}

function numberValue<T>(value: T): number | undefined {
  return isNumber(value) ? value : undefined;
}

// Mirrors `String(value || fallback)`: a falsy config value falls back, a
// present scalar stringifies, and objects keep their default tag.
function defaultedText<T>(value: T, fallback: string): string {
  return value ? stringifyScalar(value) || String(value) : fallback;
}

export function unwrapRetryError<T>(error: T): ErrorRecord | null {
  let current = asErrorRecord(error);
  const seen = new Set<ErrorRecord>();

  while (current?.lastError && !seen.has(current)) {
    seen.add(current);
    current = asErrorRecord(current.lastError);
  }

  return current;
}

function bedrockErrorChain<T>(error: T): ErrorRecord[] {
  const chain: ErrorRecord[] = [];
  let current = unwrapRetryError(error);
  const seen = new Set<ErrorRecord>();

  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = asErrorRecord(current.cause);
  }

  return chain;
}

function getBedrockHttpStatus<T>(error: T): number | undefined {
  for (const record of bedrockErrorChain(error)) {
    const metadata = asErrorRecord(record.$metadata);
    const response = asErrorRecord(record.response);

    const status =
      record.status ?? record.statusCode ?? metadata?.httpStatusCode ?? response?.status;

    if (isInteger(status)) return status;
  }

  return undefined;
}

function getHeaderCaseInsensitive<T>(headers: T, headerName: string): string | undefined {
  if (!headers) return undefined;

  if (isHeaderGetter(headers)) {
    const value = headers.get(headerName);

    return isString(value) && value ? value : undefined;
  }

  const normalizedName = headerName.toLowerCase();

  if (isHeaderBag(headers)) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === normalizedName && isString(value)) return value;
    }
  }

  return undefined;
}

function normalizeBedrockExceptionType<T>(value: T): string | undefined {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  const namespaceSeparator = trimmed.lastIndexOf("#");

  const withoutNamespace =
    namespaceSeparator === -1 ? trimmed : trimmed.slice(namespaceSeparator + 1);

  const suffixSeparator = withoutNamespace.indexOf(":");

  const normalized =
    suffixSeparator === -1 ? withoutNamespace : withoutNamespace.slice(0, suffixSeparator);

  return normalized.trim() || undefined;
}

function getBedrockExceptionType<T>(error: T): string | undefined {
  for (const record of bedrockErrorChain(error)) {
    const response = asErrorRecord(record.response);
    const headers = record.responseHeaders || response?.headers;
    const data = asErrorRecord(record.data);

    const candidates = [
      getHeaderCaseInsensitive(headers, "x-amzn-errortype"),
      data?.code,
      data?.__type,
      data?.type,
      record.type,
      record.code,
      record.name,
    ];

    for (const candidate of candidates) {
      const type = normalizeBedrockExceptionType(candidate);

      if (type && !["Error", "AI_APICallError", "AI_RetryError"].includes(type)) return type;
    }
  }

  return undefined;
}

function getBedrockRequestId<T>(error: T): string | undefined {
  for (const record of bedrockErrorChain(error)) {
    const response = asErrorRecord(record.response);
    const headers = record.responseHeaders || response?.headers || {};
    const metadata = asErrorRecord(record.$metadata);

    const requestId =
      metadata?.requestId ||
      record.requestId ||
      getHeaderCaseInsensitive(headers, "x-amzn-requestid") ||
      getHeaderCaseInsensitive(headers, "x-amz-request-id");

    if (isString(requestId) && requestId) return requestId;
  }

  return undefined;
}

function getBedrockErrorCode<T>(error: T): string | undefined {
  for (const record of bedrockErrorChain(error)) {
    if (isString(record.code)) return record.code;
    const causeCode = asErrorRecord(record.cause)?.code;

    if (isString(causeCode)) return causeCode;
  }

  return undefined;
}

function isBedrockTimeout<T>(error: T): boolean {
  const status = getBedrockHttpStatus(error);
  const type = (getBedrockExceptionType(error) || "").toLowerCase();
  const code = (getBedrockErrorCode(error) || "").toUpperCase();

  return (
    status === 408 ||
    type === "timeouterror" ||
    type.includes("requesttimeout") ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  );
}

function isSafeBedrockNetworkError<T>(error: T): boolean {
  if (getBedrockHttpStatus(error) !== undefined) return false;
  const code = (getBedrockErrorCode(error) || "").toUpperCase();

  if (BEDROCK_SAFE_NETWORK_CODES.has(code)) return true;

  return bedrockErrorChain(error).some(
    (record) =>
      isString(record.name) &&
      record.name === "TypeError" &&
      /fetch failed|network/i.test(stringifyScalar(record.message))
  );
}

function getBedrockFailureKind<T>(error: T): string {
  const status = getBedrockHttpStatus(error);
  const type = (getBedrockExceptionType(error) || "").toLowerCase();

  const message = bedrockErrorChain(error)
    .map((record) => stringifyScalar(record.message))
    .join(" ")
    .toLowerCase();

  if (status === 503 || type.includes("serviceunavailable")) return "unavailable";

  if (
    status === 429 ||
    type.includes("throttl") ||
    type.includes("toomanyrequests") ||
    message.includes("too many requests")
  ) {
    return "throttled";
  }

  if (isBedrockTimeout(error)) return "timeout";

  if (isSafeBedrockNetworkError(error)) return "network";

  return "other";
}

function shouldRetryBedrockError<T>(error: T): boolean {
  return ["unavailable", "throttled", "timeout", "network"].includes(getBedrockFailureKind(error));
}

function sleepWithAbort(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);

      return;
    }

    const abortSignal = signal;

    const onTimeout = () => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    };

    const timer = setTimeout(onTimeout, delay);

    const onAbort = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      reject(abortSignal?.reason);
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runAbortableOperation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();

  let onAbort: () => void = () => {};

  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    signal.throwIfAborted();

    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface BedrockRetryOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (delay: number, signal?: AbortSignal) => Promise<void>;
}

export async function runBedrockRequest<T>(
  operation: () => Promise<T>,
  options: BedrockRetryOptions = {}
): Promise<T> {
  const {
    signal,
    maxAttempts = BEDROCK_MAX_ATTEMPTS,
    initialDelayMs = BEDROCK_INITIAL_DELAY_MS,
    maxDelayMs = BEDROCK_MAX_DELAY_MS,
    random = Math.random,
    sleep = sleepWithAbort,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal?.throwIfAborted();

    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      const underlying = unwrapRetryError(error);

      if (attempt === maxAttempts || !shouldRetryBedrockError(underlying)) throw underlying;
      const backoffCeiling = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt - 1));
      await sleep(Math.floor(random() * backoffCeiling), signal);
    }
  }

  throw new Error("Bedrock retry loop exited unexpectedly");
}

function getBedrockTechnicalDetails<T>(error: T): MappedEnterpriseError["technicalDetails"] {
  const underlying = unwrapRetryError(error);
  const status = getBedrockHttpStatus(underlying);
  const exceptionType = getBedrockExceptionType(underlying);
  const requestId = getBedrockRequestId(underlying);

  return {
    ...(status !== undefined ? { status } : {}),
    ...(exceptionType !== undefined ? { exceptionType } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    underlyingError: messageOrRuntime(underlying, underlying),
  };
}

function mapBedrockError<T>(
  error: T,
  config: EnterpriseProviderConfig = {}
): MappedEnterpriseError {
  const underlying = unwrapRetryError(error);
  const underlyingRecord = asErrorRecord(underlying);

  const msg = messageThenCode(underlyingRecord, underlying);

  const status = getBedrockHttpStatus(underlying);
  const exceptionType = getBedrockExceptionType(underlying) || "";
  const signature = `${exceptionType} ${msg}`.toLowerCase();
  const profile = defaultedText(config.bedrockProfile, "default");
  const region = defaultedText(config.bedrockRegion, "us-east-1");
  const technicalDetails = getBedrockTechnicalDetails(underlying);

  const withDetails = (mapped: MappedEnterpriseError): MappedEnterpriseError => ({
    ...mapped,
    technicalDetails,
  });

  if (signature.includes("expiredtoken") || signature.includes("expired")) {
    return withDetails({
      message: "AWS SSO session expired.",
      messageKey: "reasoning.enterprise.errors.bedrock.ssoExpired",
      action: "Run the command below in your terminal to re-authenticate:",
      actionKey: "reasoning.enterprise.errors.bedrock.actions.reauthenticate",
      copyCommand: `aws sso login --profile ${profile}`,
      retryable: true,
    });
  }

  if (
    status === 401 ||
    signature.includes("unrecognizedclient") ||
    signature.includes("invalidclienttoken") ||
    signature.includes("invalidsignature") ||
    signature.includes("incompletesignature") ||
    signature.includes("signaturedoesnotmatch")
  ) {
    return withDetails({
      message: "AWS credentials were rejected. Check the access key ID, secret, and session token.",
      messageKey: "reasoning.enterprise.errors.bedrock.credentialsRejected",
    });
  }

  if (status === 403 || signature.includes("accessdenied") || signature.includes("permission")) {
    return withDetails({
      message: `AWS Bedrock denied this request. Ask your AWS administrator to grant permission to invoke the selected model in region ${region}.`,
      messageKey: "reasoning.enterprise.errors.bedrock.accessDenied",
      messageParams: { region },
    });
  }

  if (signature.includes("resourcenotfound") || signature.includes("modelnotfound")) {
    return withDetails({
      message: `AWS Bedrock could not find the selected model in region ${region}. Check the model ID and whether it is available in that region.`,
      messageKey: "reasoning.enterprise.errors.bedrock.modelNotFound",
      messageParams: { region },
    });
  }

  if (status === 400 || signature.includes("validationexception")) {
    return withDetails({
      message: `AWS Bedrock rejected the model configuration for region ${region}. Check the model ID, inference profile, and region.`,
      messageKey: "reasoning.enterprise.errors.bedrock.configurationRejected",
      messageParams: { region },
    });
  }

  if (
    signature.includes("credentialsprovidererror") ||
    signature.includes("configerror") ||
    signature.includes("region is missing") ||
    signature.includes("could not load credentials")
  ) {
    return withDetails({
      message: "AWS Bedrock is not configured correctly. Check the region and AWS credentials.",
      messageKey: "reasoning.enterprise.errors.bedrock.notConfigured",
    });
  }

  const kind = getBedrockFailureKind(underlying);

  if (kind === "unavailable") {
    return withDetails({
      message:
        "AWS Bedrock is temporarily unavailable due to high demand. This is an AWS service issue, not an Gristmill outage. Please try again in a few minutes.",
      messageKey: "reasoning.enterprise.errors.bedrock.serviceUnavailable",
      retryable: true,
    });
  }

  if (kind === "throttled") {
    return withDetails({
      message:
        "AWS Bedrock is temporarily limiting requests because it is receiving too many. Please wait a moment and try again. If this continues, ask your AWS administrator to check your Bedrock usage and quotas.",
      messageKey: "reasoning.enterprise.errors.bedrock.throttled",
      retryable: true,
    });
  }

  if (kind === "timeout") {
    return withDetails({
      message:
        "AWS Bedrock did not respond in time. Please try again. If this continues, check your internet connection and AWS Bedrock service status.",
      messageKey: "reasoning.enterprise.errors.bedrock.timeout",
      retryable: true,
    });
  }

  if (kind === "network") {
    return withDetails({
      message: "AWS Bedrock could not be reached. Check your internet connection and try again.",
      messageKey: "reasoning.enterprise.errors.bedrock.network",
      retryable: true,
    });
  }

  return withDetails({
    message: `AWS Bedrock error: ${msg}`,
    messageKey: "reasoning.enterprise.errors.bedrock.unknown",
    messageParams: { error: msg },
  });
}

function mapAzureError<T>(error: T): MappedEnterpriseError {
  const record = asErrorRecord(error);
  const status = numberValue(record?.status) ?? numberValue(record?.statusCode);
  const msg = firstPresentThenTruthy(record, error);

  if (status === 401 || msg.includes("Unauthorized") || msg.includes("invalid")) {
    return { message: "Invalid API key for Azure OpenAI resource." };
  }

  if (status === 404 || msg.includes("DeploymentNotFound") || msg.includes("not found")) {
    return {
      message: "Deployment not found. Verify the deployment name in Azure portal.",
      action: "Check Azure OpenAI Studio → Deployments for the correct name.",
    };
  }

  if (status === 429 || msg.includes("TooManyRequests") || msg.includes("rate")) {
    return {
      message: "Azure OpenAI rate limit reached. Wait or increase quota.",
      retryable: true,
    };
  }

  if (classifyNetworkError(error).isNetworkError || msg.includes("fetch failed")) {
    return {
      message: "Cannot reach Azure endpoint. Check the endpoint URL.",
      action: "Ensure the URL looks like: https://yourresource.openai.azure.com",
    };
  }

  if (msg.includes("content_filter") || msg.includes("ContentFilter")) {
    return {
      message: "Content was filtered by Azure content safety. Adjust safety settings if needed.",
    };
  }

  return { message: `Azure OpenAI error: ${msg}` };
}

function mapVertexError<T>(error: T, config: EnterpriseProviderConfig = {}): MappedEnterpriseError {
  const record = asErrorRecord(error);
  const msg = firstPresentThenTruthy(record, error);
  const project = defaultedText(config.vertexProject, "");

  if (msg.includes("UNAUTHENTICATED") || msg.includes("Could not load the default credentials")) {
    return {
      message: "GCP credentials not found.",
      action: "Run the command below in your terminal:",
      copyCommand: "gcloud auth application-default login",
      retryable: true,
    };
  }

  if (msg.includes("PERMISSION_DENIED") || msg.includes("403")) {
    return {
      message: "Vertex AI API not enabled or insufficient permissions.",
      action: "Enable the API in GCP Console.",
      copyCommand: `gcloud services enable aiplatform.googleapis.com --project=${project}`,
    };
  }

  if (msg.includes("NOT_FOUND") || msg.includes("404")) {
    return {
      message: `Model not found in project ${project}.`,
      action: "Check the model ID and ensure it's available in your region.",
    };
  }

  if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
    return {
      message: "Vertex AI quota exceeded. Check your quota in GCP Console.",
      retryable: true,
    };
  }

  if (msg.includes("INVALID_ARGUMENT")) {
    return { message: "Invalid Vertex AI API key or argument." };
  }

  return { message: `Vertex AI error: ${msg}` };
}

/**
 * Maps a provider-specific error to an actionable user message.
 * @param {"bedrock"|"azure"|"vertex"} provider
 * @param {Error} error
 * @param {Record<string,string>} config - provider config for contextual messages
 * @returns {{ message: string, action?: string, copyCommand?: string, retryable?: boolean }}
 */
export function mapEnterpriseError<T>(
  provider: string,
  error: T,
  config: EnterpriseProviderConfig = {}
): MappedEnterpriseError {
  switch (provider) {
    case "bedrock":
      return mapBedrockError(error, config);
    case "azure":
      return mapAzureError(error);
    case "vertex":
      return mapVertexError(error, config);
    default:
      return { message: messageOrRuntime(asErrorRecord(error), error) };
  }
}

const ENTERPRISE_PROVIDERS: readonly string[] = ["bedrock", "azure", "vertex"];

export function isEnterpriseProvider(value: unknown): value is EnterpriseProvider {
  return typeof value === "string" && ENTERPRISE_PROVIDERS.includes(value);
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
]);

const BLOCKED_SUFFIXES = [".internal", ".localhost", ".local"];

function isPrivateIPv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (!match) return false;
  const [, a, b] = match.map(Number);

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(hostname: string): boolean {
  if (hostname === "::1") return true;

  if (/^(fe80|fc[0-9a-f]{2}|fd[0-9a-f]{2}):/i.test(hostname)) return true;
  // The URL parser rewrites an IPv4-mapped address to its hex form, so
  // "::ffff:169.254.169.254" reaches us as "::ffff:a9fe:a9fe".
  const mappedHex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);

  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);

    return isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }

  const mapped = hostname.match(/^::ffff:(.+)$/i);

  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

/**
 * SSRF guard for enterprise HTTP endpoints (currently only Azure).
 * Throws if the URL is non-HTTPS or resolves to a private/metadata host.
 * Note: DNS rebinding is not mitigated — hostnames resolve per-request.
 */
export function validateEnterpriseEndpoint(endpoint: string | null | undefined): void {
  if (!endpoint) return;
  const url = new URL(endpoint);

  if (url.protocol !== "https:") {
    throw new Error("Endpoint must use HTTPS.");
  }

  // URL.hostname keeps the brackets around an IPv6 literal ("[::1]"), which no
  // isPrivateIPv6 branch can match — strip them or the whole IPv6 arm is dead.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    BLOCKED_HOSTS.has(hostname) ||
    BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isPrivateIPv4(hostname) ||
    isPrivateIPv6(hostname)
  ) {
    throw new Error("Private/metadata endpoints are not allowed.");
  }
}

/**
 * Extracts the enterprise credential/config subset from an IPC payload
 * so SDK factories receive only the fields they expect. Each field is kept
 * only when it is a string; anything else is dropped, as before.
 */
export function pickEnterpriseConfig(
  config: EnterpriseProviderConfig = {}
): EnterpriseRuntimeConfig {
  return {
    bedrockRegion: isString(config.bedrockRegion) ? config.bedrockRegion : undefined,
    bedrockProfile: isString(config.bedrockProfile) ? config.bedrockProfile : undefined,
    bedrockAccessKeyId: isString(config.bedrockAccessKeyId) ? config.bedrockAccessKeyId : undefined,
    bedrockSecretAccessKey: isString(config.bedrockSecretAccessKey)
      ? config.bedrockSecretAccessKey
      : undefined,
    bedrockSessionToken: isString(config.bedrockSessionToken)
      ? config.bedrockSessionToken
      : undefined,
    azureEndpoint: isString(config.azureEndpoint) ? config.azureEndpoint : undefined,
    azureApiVersion: isString(config.azureApiVersion) ? config.azureApiVersion : undefined,
    vertexProject: isString(config.vertexProject) ? config.vertexProject : undefined,
    vertexLocation: isString(config.vertexLocation) ? config.vertexLocation : undefined,
  };
}
