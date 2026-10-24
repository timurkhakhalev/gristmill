// Retry policy for meeting processing. A rejected stage is classified here and
// reduced to one decision: pause, block, retry with backoff, or fail. Persistence
// and notification stay in the worker; this module is pure decision logic.
//
// `failureFromUnknown` is the unknown-error boundary: providers attach optional
// code/status fields to plain Error objects, so every field read tolerates their
// absence (exact-file override: no-unknown-parameters).
export const AUTO_RETRY_LIMIT = 3;

const RETRY_BASE_SECONDS = 5;

const RETRY_MAX_SECONDS = 300;

export class MeetingProcessingFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: "blocked" | "failed" | "cancelled",
    message?: string
  ) {
    super(message ?? code);
  }
}

export type RetryDecision =
  | { action: "pause" }
  | { action: "blocked"; code: string }
  | { action: "retry"; code: string; retryAt: string; retryCount: number }
  | { action: "failed"; code: string };

export function decideRetry(input: {
  error: unknown;
  retryCount: number;
  isCapturing: () => boolean;
  now: () => number;
}): RetryDecision {
  const failure =
    input.error instanceof MeetingProcessingFailure
      ? input.error
      : failureFromError(
          input.error instanceof Error ? input.error : new Error(String(input.error))
        );

  if (failure.status === "cancelled") return { action: "pause" };

  if (
    input.error instanceof Error &&
    input.error.name === "AbortError" &&
    input.isCapturing()
  ) {
    return { action: "pause" };
  }

  if (failure.status === "blocked") return { action: "blocked", code: failure.code };

  if (isTransientFailure(failure)) {
    const retryCount = input.retryCount + 1;

    if (retryCount <= AUTO_RETRY_LIMIT) {
      const delaySeconds = Math.min(
        RETRY_MAX_SECONDS,
        RETRY_BASE_SECONDS * 2 ** input.retryCount
      );

      return {
        action: "retry",
        code: failure.code,
        retryAt: new Date(input.now() + delaySeconds * 1000).toISOString(),
        retryCount,
      };
    }
  }

  return { action: "failed", code: failure.code };
}

function isTransientFailure(error: MeetingProcessingFailure): boolean {
  return (
    error.code === "PROVIDER_RATE_LIMITED" ||
    error.code === "TRANSCRIPTION_TRANSPORT_ERROR" ||
    error.code === "TRANSIENT_NETWORK_ERROR" ||
    /Gemini API error 5\d\d/.test(error.message)
  );
}

function failureFromError(error: Error): MeetingProcessingFailure {
  // SAFETY: providers attach optional code/status fields to plain Error
  // objects; every access below tolerates their absence.
  const detail = error as Error & { code?: string; status?: number; statusCode?: number };

  if (error.name === "AbortError") {
    return new MeetingProcessingFailure("processing-cancelled", "cancelled", error.message);
  }

  const status = detail.status ?? detail.statusCode;

  if (status === 429)
    return new MeetingProcessingFailure("PROVIDER_RATE_LIMITED", "failed", error.message);

  if ((status !== undefined && status >= 500) || error instanceof TypeError) {
    return new MeetingProcessingFailure("TRANSIENT_NETWORK_ERROR", "failed", error.message);
  }

  const code = detail.code || "processing-error";

  if (
    [
      "api-key-missing",
      "invalid-key",
      "INVALID_KEY",
      "API_KEY_MISSING",
      "reasoning-model-missing",
      "reasoning-endpoint-missing",
      "reasoning-endpoint-invalid",
      "reasoning-provider-missing",
      "unsupported-reasoning-provider",
      "unsupported-enterprise-reasoning-route",
      "enterprise-reasoning-unavailable",
      "SELF_HOSTED_ENDPOINT_INVALID",
      "DIARIZATION_MODEL_MISSING",
      "MODEL_NOT_DOWNLOADED",
      "MODEL_NOT_FOUND",
      "LLAMASERVER_NOT_FOUND",
      "LOCAL_SERVER_UNAVAILABLE",
      "bb-not-installed",
      "bb-project-mismatch",
    ].includes(code)
  ) {
    return new MeetingProcessingFailure(code, "blocked", error.message);
  }

  return new MeetingProcessingFailure(code, "failed", error.message);
}
