const debugLogger = require("./debugLogger");

const CODE_TO_KEY: Record<string, string> = {
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

const NAME_TO_KEY: Record<string, string> = {
  TimeoutError: "streaming.errors.cloudUnreachable.timeout",
  AbortError: "streaming.errors.cloudUnreachable.timeout",
};

export interface NetworkErrorClassification {
  code?: string;
  messageKey?: string;
  isNetworkError: boolean;
}

export function classifyNetworkError(err: unknown): NetworkErrorClassification {
  if (!err) return { isNetworkError: false };
  const record = err as { code?: string; cause?: { code?: string }; name?: string };
  const code = record.code || record.cause?.code;

  if (code && CODE_TO_KEY[code]) {
    return { code, messageKey: CODE_TO_KEY[code], isNetworkError: true };
  }

  if (record.name && NAME_TO_KEY[record.name]) {
    return { code: record.name, messageKey: NAME_TO_KEY[record.name], isNetworkError: true };
  }

  return { isNetworkError: false };
}

export function classifyAndLog(err: unknown, url: string): NetworkErrorClassification {
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
