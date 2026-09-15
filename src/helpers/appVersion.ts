const CANONICAL_APP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseCanonicalAppVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = CANONICAL_APP_VERSION.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? (parts as [number, number, number]) : null;
}

export function isCanonicalAppVersion(value: unknown): boolean {
  return parseCanonicalAppVersion(value) !== null;
}
