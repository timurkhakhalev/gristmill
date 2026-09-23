// Single source of truth for direct batch speech-to-text routing across
// dictation, retry, and upload. Streaming provider selection is a live-recorder
// concern and stays in audioManager.
//
// Shared by the renderer and main; the main build emits JS and rewrites the
// explicit import extensions. Keep this module independent of stores.
// Routes never carry secrets — `auth.keyRef` names the key slot the executor
// resolves itself.
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants.mts";
import {
  STREAMING_ONLY_PROVIDERS,
  DEEPGRAM_FILE_SIZE_LIMIT,
  ELEVENLABS_FILE_SIZE_LIMIT,
} from "../config/transcriptionCapabilities.ts";
import {
  isSecureHttpEndpoint,
  isAzureOpenAIEndpoint,
  buildAzureTranscriptionUrl,
} from "../utils/urlUtils.ts";
import {
  isSelfHostedTranscription,
  resolveSelfHostedTranscriptionModel,
} from "./selfHostedTranscription.ts";
import {
  isTinfoilInferenceUrl,
  TINFOIL_PROXY_REQUIRED_ERROR,
  type TranscriptionProviderBaseUrl,
} from "../services/transcriptionBaseUrl.ts";

const BYOK_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

// Gemini's Interactions API takes inline base64 audio inside a 20 MB total
// request cap; base64 inflates 4/3, so cap the raw audio lower.
const GEMINI_FILE_SIZE_LIMIT = 14 * 1024 * 1024;

export function byokFileSizeLimit(provider: string): number {
  return provider === "gemini"
    ? GEMINI_FILE_SIZE_LIMIT
    : provider === "elevenlabs"
      ? ELEVENLABS_FILE_SIZE_LIMIT
      : provider === "deepgram"
        ? DEEPGRAM_FILE_SIZE_LIMIT
        : BYOK_FILE_SIZE_LIMIT;
}

// Route caps vary by provider (Gemini's inline-base64 limit is the lowest), so
// the message reports the cap that actually applied.
export function byokSizeCapError(sizeCapBytes: number): string {
  return `File too large. Maximum size for bring-your-own-key is ${Math.floor(
    sizeCapBytes / (1024 * 1024)
  )} MB.`;
}

// mistral/xai have no OpenAI-compatible transcription endpoint — the upload
// and retry executors talk to them directly at these URLs.
export const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";

export const XAI_STT_URL = "https://api.x.ai/v1/stt";

const CUSTOM_ENDPOINT_INVALID_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.customEndpointInvalid";
const STREAMING_ONLY_PROVIDER_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.streamingOnlyProvider";

const PROVIDER_KEY_MISSING_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.providerKeyMissing";

export interface TranscriptionRouteSettings {
  transcriptionMode?: string;
  useLocalWhisper?: boolean;
  remoteTranscriptionUrl?: string;
  remoteTranscriptionModel?: string;
  cloudTranscriptionProvider?: string;
  cloudTranscriptionModel?: string;
  cloudTranscriptionBaseUrl?: string;
  cortiEnvironment?: string;
  cortiTenant?: string;
  preferredLanguage?: string;
}

export interface TranscriptionRouteInput {
  /** Policy-EFFECTIVE, scope-resolved snapshot — the resolver never re-maps selections. */
  settings: TranscriptionRouteSettings;
  /** Provider registry, for the Tinfoil-host guard. Renderer passes ModelRegistry, main the raw JSON. */
  providers?: readonly TranscriptionProviderBaseUrl[];
  /**
   * Whether the selected provider's BYOK key is present — a presence flag, never
   * the key. Consulted only for realtime-only providers: the recorder skips
   * streaming when their key is missing, and the batch guard below would then
   * blame the transport instead of the key. Omit when unknown (retry, upload).
   */
  hasProviderKey?: boolean;
  request?: {
    /** Explicit model override; doubles as the Azure deployment name. */
    model?: string;
    /** Translation-aware language (dictation's getEffectiveSttLanguage) — wins over preferredLanguage. */
    effectiveLanguage?: string;
  };
}

export type TranscriptionRoute =
  | { transport: "error"; message: string; code?: string; messageKey?: string }
  | { transport: "local" }
  | {
      transport: "proxied";
      provider: "tinfoil" | "mistral" | "xai" | "corti" | "gemini" | "deepgram" | "elevenlabs";
      model: string | null;
      language?: string;
      sizeCapBytes: number;
      cortiEnvironment?: string;
      cortiTenant?: string;
    }
  | {
      transport: "http-batch";
      provider: "self-hosted" | "custom" | "openai" | "groq";
      endpoint: string;
      model: string | null;
      auth: { scheme: "bearer" | "azure-api-key" | "none"; keyRef: string | null };
      sizeCapBytes: number | null;
      language?: string;
    };

// xAI STT supports 25 languages; language must be in this set to enable ITN via format=true
export const XAI_STT_LANGUAGES = new Set([
  "ar",
  "cs",
  "da",
  "de",
  "en",
  "es",
  "fa",
  "fil",
  "fr",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "mk",
  "ms",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sv",
  "th",
  "tr",
  "vi",
]);

// Prefix-matched rather than registry-checked on purpose: this module loads in
// the packaged main process without the registry, and strict validation would
// reset the model of anyone still on a retired id. The registry-backed picker
// rules live in settingsStore; transcriptionRouteModelAgreement.test.js pins the
// two together for every shipping model.
export function resolveByokModel(provider: string, configuredModel?: string): string {
  const trimmed = (configuredModel || "").trim();
  if (provider === "custom") return trimmed || "whisper-1";
  if (trimmed) {
    const matchesProvider =
      (provider === "groq" && trimmed.startsWith("whisper-large-v3")) ||
      (provider === "openai" &&
        (trimmed.startsWith("gpt-transcribe") ||
          trimmed.startsWith("gpt-4o") ||
          trimmed === "whisper-1")) ||
      (provider === "mistral" && trimmed.startsWith("voxtral-")) ||
      (provider === "corti" && trimmed.startsWith("corti-")) ||
      (provider === "gemini" && trimmed.startsWith("gemini-")) ||
      (provider === "deepgram" && (trimmed.startsWith("nova-") || trimmed.startsWith("flux-"))) ||
      (provider === "elevenlabs" && trimmed === "scribe_v2") ||
      (provider === "assemblyai" &&
        (trimmed.startsWith("universal-") || trimmed.startsWith("slam-")));
    if (matchesProvider) return trimmed;
  }
  if (provider === "groq") return "whisper-large-v3-turbo";
  if (provider === "xai") return "grok-stt";
  if (provider === "mistral") return "voxtral-mini-latest";
  if (provider === "corti") return "corti-transcribe";
  if (provider === "gemini") return "gemini-3.5-transcribe";
  if (provider === "deepgram") return "nova-3";
  if (provider === "elevenlabs") return "scribe_v2";
  if (provider === "assemblyai") return "universal-3-5-pro";
  return "gpt-transcribe";
}

function error(message: string, code?: string, messageKey?: string): TranscriptionRoute {
  return { transport: "error", message, code, messageKey };
}

// Azure routes by deployment in the path and needs an api-version query, so the
// plain {base}/audio/transcriptions shape returns DeploymentNotFound. Takes the
// raw URL because normalization strips the suffix that marks a pinned deployment.
// Shared by self-hosted and Custom — deriveTranscriptionMode files Azure
// endpoints under either, depending on when the user configured them.
function buildBatchEndpoint(rawUrl: string, base: string, model: string | null): string {
  const fallback = buildApiUrl(base, "/audio/transcriptions");
  if (!isAzureOpenAIEndpoint(base)) return fallback;
  return buildAzureTranscriptionUrl(rawUrl, model || "") || fallback;
}

function customEndpointError(): TranscriptionRoute {
  return error(
    "Custom transcription endpoint is invalid or unsupported",
    "CUSTOM_ENDPOINT_INVALID",
    CUSTOM_ENDPOINT_INVALID_MESSAGE_KEY
  );
}

export function resolveTranscriptionRoute({
  settings,
  providers = [],
  hasProviderKey,
  request,
}: TranscriptionRouteInput): TranscriptionRoute {
  const s = settings || {};
  const language =
    request?.effectiveLanguage ??
    (!s.preferredLanguage || s.preferredLanguage === "auto"
      ? undefined
      : s.preferredLanguage.split("-")[0]);

  // Enterprise organization routing is intentionally not part of this direct
  // provider resolver. Keep stale enterprise selections fail-closed until a
  // direct provider is chosen.
  if (s.transcriptionMode === "enterprise") {
    return error(
      "Enterprise transcription is not supported in this build.",
      "UNSUPPORTED_TRANSCRIPTION_MODE"
    );
  }

  // Self-hosted wins over everything, including stale useLocalWhisper flags.
  // The route needs a configured URL: `byok + custom` also persists
  // transcriptionMode="self-hosted" (deriveTranscriptionMode), so
  // mode-without-URL falls through to the custom branch (fail-closed there)
  // instead of breaking that population, and everything else fails closed.
  if (s.transcriptionMode === "self-hosted") {
    if (isSelfHostedTranscription(s)) {
      const rawUrl = (s.remoteTranscriptionUrl || "").trim();
      const base = normalizeBaseUrl(rawUrl);
      if (!base || !isSecureHttpEndpoint(base)) {
        return error("Self-hosted transcription URL is invalid or unsupported");
      }
      const selfHostedModel = resolveSelfHostedTranscriptionModel(s);
      return {
        transport: "http-batch",
        provider: "self-hosted",
        endpoint: buildBatchEndpoint(rawUrl, base, selfHostedModel),
        model: selfHostedModel,
        auth: { scheme: "none", keyRef: null },
        sizeCapBytes: null,
        language,
      };
    }
    if (s.cloudTranscriptionProvider !== "custom") {
      return error("Self-hosted transcription URL is not configured");
    }
  }

  // Engine and model selection stay with the local managers.
  if (s.useLocalWhisper) {
    return { transport: "local" };
  }

  const provider = s.cloudTranscriptionProvider || "openai";
  const model = resolveByokModel(provider, request?.model ?? s.cloudTranscriptionModel);

  if (provider === "tinfoil" || provider === "mistral" || provider === "xai") {
    return {
      transport: "proxied",
      provider,
      // Tinfoil's attested client resolves its own model; xAI's API takes none.
      model: provider === "mistral" ? model : provider === "xai" ? "grok-stt" : null,
      language:
        provider === "xai" && language && !XAI_STT_LANGUAGES.has(language) ? undefined : language,
      sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
    };
  }
  if (provider === "gemini") {
    return {
      transport: "proxied",
      provider,
      model,
      language,
      sizeCapBytes: GEMINI_FILE_SIZE_LIMIT,
    };
  }
  if (provider === "deepgram") {
    if (!model.startsWith("nova-")) {
      return error(
        "Deepgram file transcription with diarization requires a Nova model. Select Nova-3.",
        "DEEPGRAM_MODEL_UNSUPPORTED"
      );
    }
    return {
      transport: "proxied",
      provider,
      model,
      language,
      sizeCapBytes: DEEPGRAM_FILE_SIZE_LIMIT,
    };
  }
  if (provider === "elevenlabs") {
    return {
      transport: "proxied",
      provider,
      model,
      language,
      sizeCapBytes: ELEVENLABS_FILE_SIZE_LIMIT,
    };
  }
  if (provider === "corti") {
    return {
      transport: "proxied",
      provider,
      model,
      // Corti requires a concrete primaryLanguage; default to English when auto-detecting
      language: language || "en",
      sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
      cortiEnvironment: s.cortiEnvironment || "us",
      cortiTenant: (s.cortiTenant || "").trim() || "base",
    };
  }

  if (provider === "custom") {
    const rawUrl = (s.cloudTranscriptionBaseUrl || "").trim();
    const base = normalizeBaseUrl(rawUrl);
    if (
      !rawUrl ||
      // The untouched store default — Custom was selected but never configured;
      // passing it through would route the custom key + audio to OpenAI.
      rawUrl === API_ENDPOINTS.TRANSCRIPTION_BASE ||
      !base ||
      !isSecureHttpEndpoint(base)
    ) {
      return customEndpointError();
    }
    if (isTinfoilInferenceUrl(base, providers)) {
      return error(TINFOIL_PROXY_REQUIRED_ERROR);
    }
    // Azure authenticates with the `api-key` header; Bearer is reserved for Entra ID.
    return {
      transport: "http-batch",
      provider: "custom",
      endpoint: buildBatchEndpoint(rawUrl, base, model),
      model,
      auth: {
        scheme: isAzureOpenAIEndpoint(base) ? "azure-api-key" : "bearer",
        keyRef: "custom",
      },
      sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
      language,
    };
  }

  if (STREAMING_ONLY_PROVIDERS.has(provider)) {
    if (hasProviderKey === false) {
      return error(
        `No ${provider} API key configured. Add your key in Settings.`,
        "API_KEY_MISSING",
        PROVIDER_KEY_MISSING_MESSAGE_KEY
      );
    }
    return error(
      "This provider only supports live transcription. Choose another provider for file uploads and retries.",
      "STREAMING_ONLY_PROVIDER",
      STREAMING_ONLY_PROVIDER_MESSAGE_KEY
    );
  }

  const isGroq = provider === "groq";
  return {
    transport: "http-batch",
    provider: isGroq ? "groq" : "openai",
    endpoint: buildApiUrl(
      isGroq ? API_ENDPOINTS.GROQ_BASE : API_ENDPOINTS.TRANSCRIPTION_BASE,
      "/audio/transcriptions"
    ),
    model,
    auth: { scheme: "bearer", keyRef: isGroq ? "groq" : "openai" },
    sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
    language,
  };
}
