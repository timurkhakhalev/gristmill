const CLOUD_CHAT_PROVIDERS = new Set([
  "openai",
  "groq",
  "gemini",
  "anthropic",
  "tinfoil",
  "custom",
  "openrouter",
  "corti",
]);

export type ChatRoute =
  | { kind: "self-hosted"; baseUrl: string; apiKey: string }
  | { kind: "enterprise"; baseUrl: string; apiKey: string }
  | { kind: "local"; baseUrl: string; apiKey: string }
  | { kind: "provider"; baseUrl: string; apiKey: string };

export interface ChatRouteInput {
  provider?: string | null;
  lanUrl?: string | null;
  customApiKey?: string | null;
  isEnterpriseProvider?: boolean;
}

// Resolve Chat from Chat-owned settings only. In particular, this must never
// consult Dictation Cleanup's mode or endpoint.
export function resolveChatRoute({
  provider,
  lanUrl,
  customApiKey,
  isEnterpriseProvider = false,
}: ChatRouteInput): ChatRoute {
  // An explicit self-hosted URL is the caller's declared route — it wins even
  // over a stale enterprise provider id left in settings.
  const baseUrl = lanUrl?.trim() || "";
  if (baseUrl) {
    return {
      kind: "self-hosted",
      baseUrl,
      apiKey: customApiKey?.trim() || "",
    };
  }

  if (isEnterpriseProvider) {
    return { kind: "enterprise", baseUrl: "", apiKey: "" };
  }

  if (!CLOUD_CHAT_PROVIDERS.has(provider ?? "")) {
    return { kind: "local", baseUrl: "", apiKey: "" };
  }

  return { kind: "provider", baseUrl: "", apiKey: "" };
}
