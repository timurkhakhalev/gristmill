// Note recording only offers providers the main process will actually run:
// meeting prepare/start check ALLOWED_MEETING_PROVIDERS (derived from the
// streaming client table in meetingStreamingProviders.ts) and reject anything
// else with no user-visible message. Without this intersection, every registry
// model marked `streaming: true` reaches the notes picker — including
// dictation-only ones like Gemini Live — and fails silently there. The closure
// is pinned by test/helpers/meetingStreamingProviders.test.js.
import type { InferenceMode, LocalTranscriptionProvider } from "../contracts/inferenceSettings";

export const MEETING_STREAMING_PROVIDER_IDS = [
  "openai",
  "assemblyai",
  "deepgram",
  "corti",
  "tinfoil",
] as const;

export type MeetingStreamingProviderId = (typeof MEETING_STREAMING_PROVIDER_IDS)[number];

interface MeetingTranscriptionModel {
  id: string;
  default?: boolean;
}

export interface MeetingTranscriptionProvider {
  id: MeetingStreamingProviderId;
  models: readonly MeetingTranscriptionModel[];
}

interface ProviderCandidate {
  id: string;
  models: readonly MeetingTranscriptionModel[];
}

export interface ResolveMeetingTranscriptionOptions {
  transcriptionMode: InferenceMode;
  language: string;
  localProvider: LocalTranscriptionProvider;
  whisperModel?: string;
  parakeetModel?: string;
  cohereModel?: string;
  selectedProvider?: string;
  selectedModel?: string;
  byokProviders: readonly MeetingTranscriptionProvider[];
  cortiEnvironment?: string;
  cortiTenant?: string;
  keyterms?: readonly string[];
}

export interface LocalMeetingTranscriptionOptions {
  provider: "local";
  localProvider: LocalTranscriptionProvider;
  localModel: string;
  language: string;
}

export interface RemoteMeetingTranscriptionOptions {
  provider: `${MeetingStreamingProviderId}-realtime`;
  model: string | undefined;
  mode: "byok";
  language: string;
  environment?: string;
  tenant?: string;
  keyterms?: readonly string[];
}

export type MeetingTranscriptionOptions =
  LocalMeetingTranscriptionOptions | RemoteMeetingTranscriptionOptions;

const MEETING_STREAMING_PROVIDER_ID_SET: ReadonlySet<string> = new Set(
  MEETING_STREAMING_PROVIDER_IDS
);

const isMeetingStreamingProvider = <T extends ProviderCandidate>(
  provider: T
): provider is T & MeetingTranscriptionProvider =>
  MEETING_STREAMING_PROVIDER_ID_SET.has(provider.id);

export function filterMeetingStreamingProviders<T extends ProviderCandidate>(
  providers: readonly T[]
): Array<T & MeetingTranscriptionProvider> {
  return providers.filter(isMeetingStreamingProvider);
}

const resolveModel = (provider: MeetingTranscriptionProvider, selectedModel?: string) =>
  provider.models.find((model) => model.id === selectedModel)?.id ??
  provider.models.find((model) => model.default)?.id ??
  provider.models[0]?.id;

export function resolveMeetingTranscriptionOptions({
  transcriptionMode,
  language,
  localProvider,
  whisperModel,
  parakeetModel,
  cohereModel,
  selectedProvider,
  selectedModel,
  byokProviders,
  cortiEnvironment,
  cortiTenant,
  keyterms,
}: ResolveMeetingTranscriptionOptions): MeetingTranscriptionOptions {
  if (transcriptionMode === "local") {
    return {
      provider: "local",
      localProvider,
      localModel:
        localProvider === "nvidia"
          ? parakeetModel || "parakeet-tdt-0.6b-v3"
          : localProvider === "cohere"
            ? cohereModel || "cohere-transcribe-03-2026"
            : whisperModel || "base",
      language,
    };
  }

  // These two are reachable from a settings copy the user never made by hand —
  // the 1.6.10 follow-flag migration carried a dictation choice Note Recording
  // cannot serve — so they are sentinels that MeetingRecordingMount translates,
  // not English sentences. Anything after the colon is an argument.
  if (transcriptionMode === "self-hosted") {
    throw new Error("unsupportedSelfHosted");
  }

  if (transcriptionMode !== "providers") {
    throw new Error(`Unsupported Note Recording transcription mode: ${transcriptionMode}`);
  }

  const provider = byokProviders.find((candidate) => candidate.id === selectedProvider);
  if (!provider) {
    throw new Error(
      selectedProvider ? `unsupportedProvider:${selectedProvider}` : "noProviderSelected"
    );
  }

  const options = {
    provider: `${provider.id}-realtime`,
    model: resolveModel(provider, selectedModel),
    mode: "byok",
    language,
  } as const;

  if (provider.id === "corti") {
    return {
      ...options,
      environment: cortiEnvironment,
      tenant: cortiTenant,
      keyterms,
    };
  }

  return options;
}
