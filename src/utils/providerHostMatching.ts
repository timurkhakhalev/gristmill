// Scheme-less input is normalized to https so a bare "host/path" base still
// matches, and a subdomain counts as the same provider.
export function matchesHost(url: string | null | undefined, host: string): boolean {
  if (!url) return false;

  try {
    const normalized = url.includes("://") ? url : `https://${url}`;
    const hostname = new URL(normalized).hostname.toLowerCase();

    return hostname === host || hostname.endsWith(`.${host}`);
  } catch {
    return false;
  }
}
