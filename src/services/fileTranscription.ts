import { resolveTranscriptionRoute, type TranscriptionRoute } from "../helpers/transcriptionRoute";
import { getTranscriptionProviders } from "../models/ModelRegistry";
import type { LocalTranscriptionProvider } from "../contracts/inferenceSettings";
import type { TranscriptionResponse } from "../contracts/localFileTranscription";
import type { RemoteTranscriptionResult } from "../contracts/uploadTranscription";

// The renderer aggregate over the local and remote IPC results plus the
// orchestration-only metadata (diarization warning, chunk accounting,
// measured duration). The wire shapes themselves come from the shared
// contracts — this type only adds the composed fields.
export interface FileTranscriptionResult extends TranscriptionResponse, RemoteTranscriptionResult {
  // The transcript succeeded, but requested speaker labels could not be applied.
  diarizationWarning?: boolean;
  // Set alongside `warning` by the chunked cloud path: how much audio was lost.
  failedChunks?: number;
  totalChunks?: number;
  // Measured duration of the source audio, for persisting as
  // audio_duration_seconds. Only transcribeFileWithSpeakers sets it.
  durationSeconds?: number | null;
}

export interface DiarizationSettings {
  enabled: boolean;
  // Local sherpa-onnx models present; BYOK-native diarization doesn't need them.
  localModelsReady: boolean;
  numSpeakers: number | null;
}

export interface FileTranscriptionConfig {
  useLocalWhisper: boolean;
  localTranscriptionProvider: string;
  whisperModel: string;
  parakeetModel: string;
  cohereModel: string;
  getApiKey: () => string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionModel: string;
  language: string;
  cortiEnvironment?: string;
  cortiTenant?: string;
  transcriptionMode?: string;
  remoteTranscriptionUrl?: string;
  remoteTranscriptionModel?: string;
}

export interface TranscriptionApiKeys {
  openaiApiKey: string;
  groqApiKey: string;
  xaiApiKey: string;
  mistralApiKey: string;
  geminiApiKey: string;
  tinfoilApiKey: string;
  deepgramApiKey: string;
  assemblyaiApiKey: string;
  customTranscriptionApiKey?: string;
}

export function getTranscriptionApiKey(provider: string, keys: TranscriptionApiKeys): string {
  switch (provider) {
    case "openai":
      return keys.openaiApiKey;
    case "groq":
      return keys.groqApiKey;
    case "xai":
      return keys.xaiApiKey;
    case "mistral":
      return keys.mistralApiKey;
    case "gemini":
      return keys.geminiApiKey;
    case "tinfoil":
      return keys.tinfoilApiKey;
    case "deepgram":
      return keys.deepgramApiKey;
    case "assemblyai":
      return keys.assemblyaiApiKey;
    case "custom":
      return keys.customTranscriptionApiKey || "";
    default:
      return "";
  }
}

// Pre-flight through the shared resolver: code-carrying errors (incl. the
// Tinfoil-URL and fail-closed custom guards) surface here without an IPC
// round-trip; the main-process handler re-resolves the same fields as
// defense in depth.
export function resolveFileTranscriptionRoute(cfg: FileTranscriptionConfig): TranscriptionRoute {
  return resolveTranscriptionRoute({
    settings: {
      transcriptionMode: cfg.transcriptionMode,
      useLocalWhisper: cfg.useLocalWhisper,
      remoteTranscriptionUrl: cfg.remoteTranscriptionUrl,
      remoteTranscriptionModel: cfg.remoteTranscriptionModel,
      cloudTranscriptionProvider: cfg.cloudTranscriptionProvider,
      cloudTranscriptionModel: cfg.cloudTranscriptionModel,
      cloudTranscriptionBaseUrl: cfg.cloudTranscriptionBaseUrl,
      cortiEnvironment: cfg.cortiEnvironment,
      cortiTenant: cfg.cortiTenant,
    },
    providers: getTranscriptionProviders(),
    request: { effectiveLanguage: cfg.language || undefined },
  });
}

// Single provider dispatch shared by the single-file flow and the batch queue,
// so BYOK providers receive identical options in both.
export async function transcribeFile(
  filePath: string,
  cfg: FileTranscriptionConfig,
  diarize: boolean,
  opts: { requestId?: string; timestamps?: boolean } = {}
): Promise<FileTranscriptionResult> {
  const route = resolveFileTranscriptionRoute(cfg);
  if (route.transport === "error") {
    return {
      success: false,
      error: route.message,
      code: route.code,
      messageKey: route.messageKey,
    };
  }

  if (route.transport === "local") {
    const provider = cfg.localTranscriptionProvider as LocalTranscriptionProvider;
    return window.electronAPI.transcribeAudioFile(filePath, {
      provider,
      model:
        provider === "nvidia"
          ? cfg.parakeetModel
          : provider === "cohere"
            ? cfg.cohereModel
            : cfg.whisperModel,
      // Only Cohere consumes it (no auto-detect); passing it to whisper would
      // override its auto language detection.
      ...(provider === "cohere" && cfg.language ? { language: cfg.language } : {}),
      requestId: opts.requestId,
    });
  }

  // Self-hosted fields make the handler route to the configured server
  // (fail-closed on misconfiguration) instead of stale BYOK settings. The
  // requestId registers the execution in the shared cancel registry, so Stop
  // aborts the transport instead of only discarding the late result.
  return window.electronAPI.transcribeAudioFileByok({
    filePath,
    apiKey: cfg.getApiKey(),
    baseUrl: cfg.cloudTranscriptionBaseUrl,
    model: cfg.cloudTranscriptionModel,
    diarize: diarize || undefined,
    timestamps: opts.timestamps || undefined,
    provider: cfg.cloudTranscriptionProvider,
    language: cfg.language,
    environment: cfg.cortiEnvironment,
    tenant: cfg.cortiTenant,
    transcriptionMode: cfg.transcriptionMode,
    remoteTranscriptionUrl: cfg.remoteTranscriptionUrl,
    remoteTranscriptionModel: cfg.remoteTranscriptionModel,
    requestId: opts.requestId,
  });
}

// OpenAI/Mistral/Deepgram BYOK handle diarization inside the transcription call itself.
// Self-hosted mode routes to the user's own server, which doesn't — those users
// get local diarization like everyone else.
export function shouldUseByokDiarize(
  cfg: FileTranscriptionConfig,
  diarizationEnabled: boolean
): boolean {
  return (
    diarizationEnabled &&
    !cfg.useLocalWhisper &&
    cfg.transcriptionMode !== "self-hosted" &&
    (cfg.cloudTranscriptionProvider === "openai" ||
      cfg.cloudTranscriptionProvider === "mistral" ||
      cfg.cloudTranscriptionProvider === "deepgram")
  );
}

interface DiarizationSettingsRequest {
  enabled: boolean;
  modelsReady: boolean;
  numSpeakers: number | null;
  config: FileTranscriptionConfig;
  ensureModels: () => Promise<boolean>;
}

// Speaker detection is opt-in but its local models download lazily, so a run
// started before they land would report "couldn't be applied" without the
// diarizer ever being invoked. Fetch them first; only the routes that diarize
// server-side can skip the download.
export async function resolveDiarizationSettings({
  enabled,
  modelsReady,
  numSpeakers,
  config,
  ensureModels,
}: DiarizationSettingsRequest): Promise<DiarizationSettings> {
  const needsLocalModels = enabled && !modelsReady && !shouldUseByokDiarize(config, enabled);
  return {
    enabled,
    localModelsReady: needsLocalModels ? await ensureModels() : modelsReady,
    numSpeakers,
  };
}

// Transcribe and diarize in parallel, then merge speaker labels into the text.
// Shared by the single-file flow and the batch queue. `durationSeconds` (when the
// source knows it, e.g. URL downloads) beats inferring duration from segments.
export async function transcribeFileWithSpeakers(
  filePath: string,
  cfg: FileTranscriptionConfig,
  diarization: DiarizationSettings,
  durationSeconds?: number | null,
  opts: { requestId?: string; timestamps?: boolean } = {}
): Promise<FileTranscriptionResult> {
  const byokDiarize = shouldUseByokDiarize(cfg, diarization.enabled);
  const diarizePromise =
    diarization.enabled && diarization.localModelsReady && !byokDiarize
      ? (window.electronAPI
          .diarizeAudioFile?.(filePath, {
            numSpeakers: diarization.numSpeakers ?? undefined,
            requestId: opts.requestId,
          })
          .catch(() => null) ?? Promise.resolve(null))
      : Promise.resolve(null);

  const [transcribed, diar] = await Promise.all([
    transcribeFile(filePath, cfg, byokDiarize, opts),
    diarizePromise,
  ]);

  // The diarizer measures the converted audio, so it covers picked files whose
  // duration the caller never knew. 0/NaN mean "unknown", hence ||.
  const measuredDuration = durationSeconds || (diar?.success && diar.durationSeconds) || null;
  const result = { ...transcribed, durationSeconds: measuredDuration };

  if (!result.success || !result.text || !diarization.enabled || result.diarized) return result;
  if (!diar?.success || !diar.segments?.length) {
    return { ...result, diarizationWarning: true };
  }

  try {
    const merged = await window.electronAPI.mergeSpeakerText(
      diar.segments,
      result.text,
      durationSeconds || 0
    );
    if (merged?.success && merged.text) return { ...result, text: merged.text };
  } catch {
    // Merge failure falls back to the plain transcript.
  }
  return { ...result, diarizationWarning: true };
}
