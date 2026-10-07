const CANONICAL_APP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

export function parseCanonicalAppVersion(value: unknown): [number, number, number] | null {
  if (!isString(value)) return null;
  const match = CANONICAL_APP_VERSION.exec(value);

  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  return [major, minor, patch].every(Number.isSafeInteger) ? [major, minor, patch] : null;
}

export function isCanonicalAppVersion(value: unknown): boolean {
  return parseCanonicalAppVersion(value) !== null;
}
