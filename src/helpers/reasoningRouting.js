// Whether a scope may borrow the fallback scope's API key along with its endpoint.
// A scope pointing somewhere of its own, or in another mode, would send that key to
// a host it was never entered for.
export function inheritsFallbackEndpoint(own, fallbackMode) {
  if (own.cloudBaseUrl || own.remoteUrl) return false;
  return !!fallbackMode && own.mode === fallbackMode;
}

const MIRRORED_ROUTING_FIELDS = [
  ["cleanupProvider", "provider"],
  ["cleanupModel", "model"],
  ["cleanupCloudMode", "cloudMode"],
  ["cleanupCloudBaseUrl", "cloudBaseUrl"],
  ["cleanupRemoteUrl", "remoteUrl"],
  ["cleanupCustomApiKey", "customApiKey"],
];

// Fan a cleanup config out to the remaining LLM scopes; each tab selects on its
// own mode, so the routing fields and endpoint must be mirrored together.
export function buildReasoningScopePatches(settings, mode) {
  const cleanup = { ...settings, cleanupMode: mode };
  const routing = Object.fromEntries(
    MIRRORED_ROUTING_FIELDS.filter(([cleanupKey]) => settings[cleanupKey] !== undefined).map(
      ([cleanupKey, field]) => [field, settings[cleanupKey]]
    )
  );
  return {
    cleanup,
    noteFormatting: { mode, ...routing },
    chatIntelligence: { mode, ...routing },
  };
}
