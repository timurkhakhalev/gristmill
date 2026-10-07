// SAFETY: lazy CommonJS seam; debugLogger's default export is the singleton.
const debugLogger = require("./debugLogger") as typeof import("./debugLogger.js").default;

interface ErrorMessageMap {
  [code: string]: string;
}

const CODE_TO_KEY: ErrorMessageMap = {
  ENOTFOUND: "streaming.errors.cloudUnreachable.dnsBlocked",
  EAI_AGAIN: "streaming.errors.cloudUnreachable.dnsBlocked",
  ECONNREFUSED: "streaming.errors.cloudUnreachable.refused",
  ECONNRESET: "streaming.errors.cloudUnreachable.refused",
  EPIPE: "streaming.errors.cloudUnreachable.refused",
  UND_ERR_SOCKET: "streaming.errors.cloudUnreachable.refused",
  ETIMEDOUT: "streaming.errors.cloudUnreachable.timeout",
  UND_ERR_CONNECT_TIMEOUT: "streaming.errors.cloudUnreachable.timeout",
  CERT_HAS_EXPIRED: "streaming.errors.cloudUnreachable.tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "streaming.errors.cloudUnreachable.tls",
  DEPTH_ZERO_SELF_SIGNED_CERT: "streaming.errors.cloudUnreachable.tls",
};

const NAME_TO_KEY: ErrorMessageMap = {
  TimeoutError: "streaming.errors.cloudUnreachable.timeout",
  AbortError: "streaming.errors.cloudUnreachable.timeout",
};

// Error objects and functions can both carry these transport fields.
interface ErrorShape {
  code?: unknown;
  cause?: unknown;
  name?: unknown;
}

function isErrorShape<T>(value: T): value is T & ErrorShape {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

export interface NetworkErrorClassification {
  code?: string;
  messageKey?: string;
  isNetworkError: boolean;
}

export function classifyNetworkError<T>(err: T): NetworkErrorClassification {
  if (!err) return { isNetworkError: false };

  const record = isErrorShape(err) ? err : null;
  const cause = record && isErrorShape(record.cause) ? record.cause : null;
  const code = (record && record.code) || (cause && cause.code);

  if (isString(code) && CODE_TO_KEY[code]) {
    return { code, messageKey: CODE_TO_KEY[code], isNetworkError: true };
  }

  const name = record && record.name;

  if (isString(name) && NAME_TO_KEY[name]) {
    return { code: name, messageKey: NAME_TO_KEY[name], isNetworkError: true };
  }

  return { isNetworkError: false };
}

export function classifyAndLog<T>(err: T, url: string): NetworkErrorClassification {
  const classified = classifyNetworkError(err);

  if (!classified.isNetworkError) return classified;
  let host: string | undefined;
  let urlPath: string | undefined;

  try {
    const parsed = new URL(url);
    host = parsed.host;
    urlPath = parsed.pathname;
  } catch {
    // url may be missing/invalid — log without host metadata
  }

  debugLogger.warn("Network error", { code: classified.code, host, urlPath }, "network");

  return classified;
}
