// Retry boundary. `quality/no-unknown-parameters` is off for this file
// (exact-file override): the retry strategies classify a value rejected from an
// awaited call (genuinely unknown) into an HTTP-status or errno-code decision
// before any field is read.
import { RETRY_CONFIG } from "../config/constants.mts";

// An error that carries an HTTP status; network faults arrive without one and
// are treated as retryable. Providers may attach the status directly or on a
// nested `.response` (SDK-style) object.
export interface HttpStatusError {
  status?: number;
  response?: { status?: number };
}

// A file-system error's `code` (e.g. "EBUSY") is what the file retry strategy
// matches. Errors and other values arrive here as unknown.
interface CodedError {
  code?: string;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
}

// A retry decision function plus the delays it uses. `unknown` is the honest
// input: these classify a value rejected from an awaited call.
export interface RetryStrategy {
  shouldRetry: (error: unknown) => boolean;
  maxRetries?: number;
  initialDelay?: number;
}

function hasStatus(error: unknown): error is HttpStatusError {
  return typeof error === "object" && error !== null;
}

function hasCode(error: unknown): error is CodedError {
  return typeof error === "object" && error !== null;
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number";
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    initialDelay = RETRY_CONFIG.INITIAL_DELAY,
    maxDelay = RETRY_CONFIG.MAX_DELAY,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

// Status lets createApiRetryStrategy tell an HTTP rejection from a network fault.
export function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

// Specific retry strategy for API calls
export function createApiRetryStrategy(): RetryStrategy {
  return {
    shouldRetry: (error: unknown) => {
      // No HTTP status means the request never got an answer (network drop, timeout).
      const status = hasStatus(error) ? (error.status ?? error.response?.status) : undefined;

      if (!isNumber(status)) return true;

      // Most 4xx are deterministic rejections. 408 is a request timeout and 429 is
      // a rate limit; both can clear on retry, as can 5xx server faults.
      return status === 408 || status === 429 || (status >= 500 && status < 600);
    },
  };
}

// Specific retry strategy for file operations
export function createFileRetryStrategy(): RetryStrategy {
  return {
    shouldRetry: (error: unknown) => {
      // Retry on temporary file system errors
      const retriableErrors = ["EBUSY", "ENOENT", "EPERM", "EAGAIN"];
      const code = hasCode(error) ? error.code : undefined;

      return isString(code) && retriableErrors.includes(code);
    },
    maxRetries: 2,
    initialDelay: 500,
  };
}
