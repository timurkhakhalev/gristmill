// Pure reasoning-scope routing helpers: no store, no DOM, no Electron.

import type { InferenceMode } from "../contracts/inferenceSettings";

interface RoutingFields {
  cloudBaseUrl?: string;
  remoteUrl?: string;
  mode: InferenceMode;
}

// Whether a scope may borrow the fallback scope's API key along with its endpoint.
// A scope pointing somewhere of its own, or in another mode, would send that key to
// a host it was never entered for.
export function inheritsFallbackEndpoint(
  own: RoutingFields,
  fallbackMode: InferenceMode | undefined
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

type CleanupPatchKey = (typeof MIRRORED_ROUTING_FIELDS)[number][0];
type MirroredField = (typeof MIRRORED_ROUTING_FIELDS)[number][1];

/** The routing fields a caller may fan out to the non-cleanup scopes. */
export interface MirroredRouting {
  provider?: string;
  model?: string;
  cloudMode?: string;
  cloudBaseUrl?: string;
  remoteUrl?: string;
  customApiKey?: string;
}

export interface ReasoningScopePatch extends MirroredRouting {
  mode: InferenceMode;
}

export interface CleanupScopePatch extends MirroredRouting {
  cleanupMode: InferenceMode;
  cleanupProvider?: string;
  cleanupModel?: string;
  cleanupCloudMode?: string;
  cleanupCloudBaseUrl?: string;
  cleanupRemoteUrl?: string;
  cleanupCustomApiKey?: string;
}

interface CleanupPatchSource {
  cleanupProvider?: string;
  cleanupModel?: string;
  cleanupCloudMode?: string;
  cleanupCloudBaseUrl?: string;
  cleanupRemoteUrl?: string;
  cleanupCustomApiKey?: string;
}

export interface ReasoningScopePatches {
  cleanup: CleanupScopePatch;
  noteFormatting: ReasoningScopePatch;
  chatIntelligence: ReasoningScopePatch;
}

// Fan a cleanup config out to the remaining LLM scopes; each tab selects on its
// own mode, so the routing fields and endpoint must be mirrored together.
export function buildReasoningScopePatches<S extends CleanupPatchSource>(
  settings: S,
  mode: InferenceMode
): ReasoningScopePatches {
  const cleanup: CleanupScopePatch = { ...settings, cleanupMode: mode };
  const mirrored: Record<MirroredField, string | undefined> = {
    provider: undefined,
    model: undefined,
    cloudMode: undefined,
    cloudBaseUrl: undefined,
    remoteUrl: undefined,
    customApiKey: undefined,
  };
  for (const [cleanupKey, field] of MIRRORED_ROUTING_FIELDS) {
    const value = settings[cleanupKey satisfies CleanupPatchKey & keyof S];
    if (value !== undefined) mirrored[field] = value;
  }
  const { provider, model, cloudMode, cloudBaseUrl, remoteUrl, customApiKey } = mirrored;
  const shared = {
    ...(provider !== undefined && { provider }),
    ...(model !== undefined && { model }),
    ...(cloudMode !== undefined && { cloudMode }),
    ...(cloudBaseUrl !== undefined && { cloudBaseUrl }),
    ...(remoteUrl !== undefined && { remoteUrl }),
    ...(customApiKey !== undefined && { customApiKey }),
  };
  return {
    cleanup,
    noteFormatting: { mode, ...shared },
    chatIntelligence: { mode, ...shared },
  };
}
