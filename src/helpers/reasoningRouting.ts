// Pure reasoning-scope routing helpers: no store, no DOM, no Electron.

import type { InferenceMode } from "../contracts/inferenceSettings";

interface RoutingFields {
  cloudBaseUrl?: string;
  remoteUrl?: string;
  mode: string;
}

// Whether a scope may borrow the fallback scope's API key along with its endpoint.
// A scope pointing somewhere of its own, or in another mode, would send that key to
// a host it was never entered for.
export function inheritsFallbackEndpoint(
  own: RoutingFields,
  fallbackMode: InferenceMode | string | undefined
): boolean {
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
] as const;

interface CleanupPatchSource {
  cleanupProvider?: string;
  cleanupModel?: string;
  cleanupCloudMode?: string;
  cleanupCloudBaseUrl?: string;
  cleanupRemoteUrl?: string;
  cleanupCustomApiKey?: string;
  [key: string]: unknown;
}

export interface ReasoningScopePatch {
  mode: InferenceMode | string;
  provider?: string;
  model?: string;
  cloudMode?: string;
  cloudBaseUrl?: string;
  remoteUrl?: string;
  customApiKey?: string;
  [key: string]: unknown;
}

// Fan a cleanup config out to the remaining LLM scopes; each tab selects on its
// own mode, so the routing fields and endpoint must be mirrored together.
export function buildReasoningScopePatches(
  settings: CleanupPatchSource,
  mode: InferenceMode | string
): { cleanup: CleanupPatchSource; noteFormatting: ReasoningScopePatch; chatIntelligence: ReasoningScopePatch } {
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
