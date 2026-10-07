/**
 * Reads a human-readable message out of an OpenAI-compatible error body. Kept free
 * of runtime imports so the shape table stays unit-testable on its own.
 */
const MAX_STRINGIFIED_LENGTH = 500;

// The most a provider error body can be: JSON scalars, nested objects and
// arrays. Callers hand over parsed JSON, so a named owner contract replaces the
// bare `unknown` boundary without importing a parser.
export interface ApiErrorRecord {
  [key: string]: ApiErrorValue;
}

export type ApiErrorValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ApiErrorRecord
  | ApiErrorValue[];

/** Type predicate for a value decoded from provider JSON. */
export function isApiErrorValue(value: unknown): value is ApiErrorValue {
  if (value === null || typeof value !== "object") return true;

  if (Array.isArray(value)) return value.every(isApiErrorValue);

  return Object.values(value).every(isApiErrorValue);
}

function isNonEmptyString(value: ApiErrorValue): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asNonEmptyString(value: ApiErrorValue): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

function isRecord(value: ApiErrorValue): value is ApiErrorRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** FastAPI/Pydantic error payloads: {detail: "..."} or {detail: [{loc, msg}]}. */
function fromDetail(container: ApiErrorValue): string | null {
  if (!isRecord(container)) return null;

  const direct = asNonEmptyString(container.detail);

  if (direct) return direct;

  if (!Array.isArray(container.detail)) return null;

  const parts: string[] = [];

  for (const entry of container.detail) {
    if (!isRecord(entry)) continue;
    const msg = asNonEmptyString(entry.msg);

    if (!msg) continue;
    const loc = Array.isArray(entry.loc) ? entry.loc : [];
    const field = asNonEmptyString(loc.length ? loc[loc.length - 1] : null);
    parts.push(field ? `${field}: ${msg}` : msg);
  }

  return parts.length ? parts.join("; ") : null;
}

function stringify(value: ApiErrorValue): string | null {
  try {
    const json = JSON.stringify(value);

    if (!json) return null;

    return json.length > MAX_STRINGIFIED_LENGTH
      ? `${json.slice(0, MAX_STRINGIFIED_LENGTH)}…`
      : json;
  } catch {
    return null;
  }
}

export function extractApiErrorMessage(errorData: ApiErrorValue, fallback: string): string {
  const safeFallback = asNonEmptyString(fallback) || "Unknown API error";

  if (!isRecord(errorData)) return safeFallback;

  const nested = isRecord(errorData.error) ? asNonEmptyString(errorData.error.message) : null;

  if (nested) return nested;

  const flat = asNonEmptyString(errorData.message);

  if (flat) return flat;

  // Nested containers first: a top-level detail usually just restates the HTTP status,
  // while the wrapped payload carries the upstream error.
  for (const container of [errorData.message, errorData.error, errorData]) {
    const detail = fromDetail(container);

    if (detail) return detail;
  }

  const errorString = asNonEmptyString(errorData.error);

  if (errorString) return errorString;

  for (const value of [errorData.message, errorData.detail, errorData.error]) {
    if (!isRecord(value) && !Array.isArray(value)) continue;
    const stringified = stringify(value);

    if (stringified) return stringified;
  }

  return safeFallback;
}
