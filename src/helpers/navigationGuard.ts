// will-navigate also fires for renderer-initiated location.reload() with the
// window's own URL (appUrl), so that URL must stay allowed.
export function isAllowedAppNavigation(url: string, appUrl?: string | null): boolean {
  if (url.startsWith("devtools://")) return true;
  if (!appUrl) return false;

  try {
    const candidate = new URL(url);
    const app = new URL(appUrl);
    // file:// URLs all share the opaque "null" origin, so protocol and
    // pathname carry the comparison there.
    return (
      candidate.origin === app.origin &&
      candidate.protocol === app.protocol &&
      candidate.pathname === app.pathname
    );
  } catch {
    return false;
  }
}

export function isExternalBrowserUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}
