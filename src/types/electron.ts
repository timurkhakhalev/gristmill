import type { ModelDefinition } from "../models/ModelRegistry";
import type { TinfoilCatalogModel } from "../models/tinfoilModels";
import type { NotesApi } from "../contracts/notes";
import type { UrlDownloadApi } from "../contracts/urlDownload";
import type { VocabularyApi } from "../contracts/vocabulary";
import type { ContainersApi } from "../contracts/containers";
import type { ChatPersistenceApi } from "../contracts/chatPersistence";
import type { ActionsApi } from "../contracts/actions";
import type { LocalFileTranscriptionApi } from "../contracts/localFileTranscription";
import type { CalendarAvailabilityApi } from "../contracts/calendarAvailability";
import type { UploadTranscriptionApi } from "../contracts/uploadTranscription";
import type { ReasoningApi } from "../contracts/reasoning";
import type { CalendarIntegrationApi } from "../contracts/calendar";
import type { NoteFilesApi } from "../contracts/noteFiles";
import type { LocalModelLifecycleApi } from "../contracts/localModelLifecycle";
import type { LocalLlmModelsApi } from "../contracts/localLlmModels";
import type { SpeakerApi } from "../contracts/speakerProfiles";
import type { TranscriptionExecutionApi } from "../contracts/transcriptionExecution";
import type { TranscriptionDataApi } from "../contracts/transcriptionData";
import type {
  LocalTranscriptionProvider,
  InferenceMode,
  SelfHostedType,
} from "../contracts/inferenceSettings";

export type ChineseScriptPreference = "simplified" | "traditional" | "as-transcribed";

export type TranscriptionStatus = "completed" | "failed" | "pending" | "discarded";

export interface PolicyFailureMetadata {
  error?: string;
  code?: string;
  status?: number;
  minAppVersion?: string;
  details?: unknown;
}

export interface NoteRecordingProviderModel {
  id: string;
  name: string;
  default?: boolean;
}

export interface NoteRecordingProvider {
  id: string;
  name: string;
  models: NoteRecordingProviderModel[];
}

// Session options every dictation streaming channel takes — the shared
// dictation-realtime-* set and the per-provider ones. `provider` is
// what fetchRealtimeToken's allowlist keys on — the renderer must always send
// it (built by dictationStreamingRouting.buildStreamingSessionOptions); the
// main process defaults a missing value to "openai-realtime".
export interface DictationRealtimeSessionOptions {
  provider: string;
  model?: string;
  mode?: "byok";
  language?: string;
  sampleRate?: number;
  keyterms?: string[];
  environment?: string;
  tenant?: string;
  preview?: boolean;
}

export type NoteRecordingConfigFailure = { success: false } & PolicyFailureMetadata;

export type NoteRecordingConfigResult =
  { success: true; providers: NoteRecordingProvider[] } | NoteRecordingConfigFailure;

export type TranscriptionErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER_ERROR"
  | "OFFLINE"
  | "AUTH_EXPIRED"
  | "AUTH_REQUIRED"
  | "LIMIT_REACHED"
  | "PROVIDER_RATE_LIMITED"
  | "API_KEY_MISSING"
  | "INVALID_KEY"
  | "MODEL_NOT_AVAILABLE"
  | "CUSTOM_ENDPOINT_INVALID"
  | null;

export type MeetingPromptVariant = "detected" | "starting" | "underway";

export interface MeetingDetectionNotificationData {
  kind: "detection";
  detectionId: string;
  source: string;
  key: string;
  event: { summary?: string | null } | null;
  variant: MeetingPromptVariant;
  joinUrl: string | null;
}

/** Why auto-end concluded the meeting is over. */
export type MeetingAutoEndReason = "mic-released" | "silence" | "process-exit";

export interface MeetingAutoEndNotificationData {
  kind: "auto-end";
  sessionId: string;
  expiresAt: number;
  reason?: MeetingAutoEndReason;
}

export type MeetingNotificationData =
  MeetingDetectionNotificationData | MeetingAutoEndNotificationData;

export interface MeetingAutoEndRequest {
  sessionId: string;
  reason?: MeetingAutoEndReason;
}

export type MeetingAutoEndAction = "restart" | "dismiss";

export interface MeetingAutoEndRestartRequest {
  sessionId: string;
}

export interface MeetingAutoEndLifecycleResult {
  success: boolean;
  reason?: "invalid-session" | "invalid-action" | "stale-session";
  error?: string;
}

/**
 * Proxied-transcription IPC results. `ipcMain.handle` drops custom error props on
 * rejection, so these handlers resolve with a serialized error instead of throwing.
 */
export type ProxyTranscriptionResult =
  | { text: string; model?: string; error?: undefined }
  | { error: string; code?: string; messageKey?: string; text?: undefined };

export interface AuthTokenState {
  token: string | null;
  generation: number;
}

export interface AuthTokenMutationResult extends AuthTokenState {
  success: boolean;
  code?: string;
}

/** The validated account scope the main process holds, as seen by any window. */
export interface ActiveAccountScope {
  accountId: string;
  authGeneration: number;
}

export interface TranscriptionItem {
  id: number;
  text: string;
  raw_text: string | null;
  timestamp: string;
  created_at: string;
  has_audio: number;
  audio_duration_ms: number | null;
  provider: string | null;
  model: string | null;
  status: TranscriptionStatus;
  error_message: string | null;
  error_code: TranscriptionErrorCode;
  route_kind?: string | null;
  client_transcription_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

// NoteItem and the Notes IPC surface live in src/contracts/notes.ts; import
// from there instead of re-adding row/cloud-era fields here.

export type ShareVisibility = "private" | "link" | "domain" | "invited";

export type NotePermission = "owner" | "editor" | "viewer";

export type NoteAccessPrincipalType = "user" | "email" | "team" | "folder" | "workspace";

export interface NoteAccessPrincipal {
  type: NoteAccessPrincipalType;
  id: string | null;
  email: string | null;
  name: string | null;
  image: string | null;
  member_count: number | null;
}

export interface NoteAccessGrant {
  id: string;
  principal: NoteAccessPrincipal;
  permission: Exclude<NotePermission, "owner">;
  source: "direct" | "team" | "folder" | "workspace";
  inherited: boolean;
  pending: boolean;
  created_at: string;
  updated_at: string;
}

export interface NoteAccessState {
  owner: NoteAccessPrincipal;
  grants: NoteAccessGrant[];
  my_permission: NotePermission;
  can_manage_access: boolean;
  can_manage_inherited_access: boolean;
}

export interface ShareSettings {
  visibility: ShareVisibility;
  token_prefix: string | null;
  domain_allowlist: string[];
  updated_by_user_id: string | null;
  updated_at: string | null;
}

export interface NoteShareInvitation {
  id: string;
  email: string;
  invited_by_user_id: string;
  accepted_at: string | null;
  revoked_at: string | null;
  last_emailed_at: string | null;
  created_at: string;
}

export interface DictionaryEntryItem {
  id: number;
  word: string;
  source: "manual" | "learned";
  created_at: string;
  updated_at: string;
  client_dict_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface SnippetEntryItem {
  id: number;
  trigger: string;
  replacement: string;
  created_at: string;
  updated_at: string;
  client_snippet_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface WhisperServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  hostname: string;
  isRemote: boolean;
  modelPath: string | null;
  modelName: string | null;
}

export interface WhisperCheckResult {
  installed: boolean;
  working: boolean;
  error?: string;
}

export interface WhisperModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  size_mb?: number;
  error?: string;
  code?: string;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface WhisperModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_mb?: number;
  error?: string;
}

export interface WhisperModelsListResult {
  success: boolean;
  models: WhisperModelResult[];
  cache_dir: string;
}

export interface FFmpegAvailabilityResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface AudioDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  ffmpeg: { available: boolean; path: string | null; error: string | null };
  whisperBinary: { available: boolean; path: string | null; error: string | null };
  whisperServer: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export type SystemAudioMode = "native" | "loopback" | "portal" | "unsupported";
export type SystemAudioStrategy =
  "native" | "loopback" | "pipewire-loopback" | "wasapi-loopback" | "unsupported";

export interface MeetingSystemAudioInterruption {
  systemAudioStrategy: SystemAudioStrategy;
  reason: "no_audio_delivered" | "device_invalidated" | "gone_quiet";
  recovering: boolean;
}

export interface SystemAudioAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  mode: SystemAudioMode;
  supportsPersistentGrant?: boolean;
  supportsPersistentPortalGrant?: boolean;
  supportsNativeCapture?: boolean;
  supportsOnboardingGrant?: boolean;
  requiresRuntimeSharePrompt?: boolean;
  strategy?: SystemAudioStrategy;
  restoreTokenAvailable?: boolean;
  portalVersion?: number | null;
  error?: string;
}

export interface ScreenRecordingAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  supported: boolean;
  /** macOS only: granted mid-session, so capture stays broken until the app relaunches. */
  needsRelaunch?: boolean;
}

export interface ScreenContextImage {
  mediaType: string;
  /** Base64 image bytes, no data-URL prefix. */
  data: string;
}

export interface WhisperDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  result?: any;
  sequence?: number;
}

export interface LocalModelDownloadStatus {
  modelType: "whisper" | "parakeet" | "llm";
  modelId: string;
  phase: "downloading" | "installing";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  sequence: number;
}

export interface ParakeetCheckResult {
  installed: boolean;
  working: boolean;
  supported?: boolean;
  path?: string;
  code?: string;
  message?: string;
  minimumMacOSVersion?: string;
}

export interface ParakeetModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  error?: string;
  code?: string;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface ParakeetModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface ParakeetModelsListResult {
  success: boolean;
  models: ParakeetModelResult[];
  cache_dir: string;
}

export interface ParakeetDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  sequence?: number;
}

export interface ParakeetTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface ParakeetDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  sherpaOnnx: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  terminalAware?: boolean;
  hasNativeBinary?: boolean;
  hasUinput?: boolean;
  hasWtype?: boolean;
  isWlroots?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

export type LlamaBackend = "cpu" | "metal" | null;

export interface LlamaServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  backend: LlamaBackend;
}

export interface LocalLLMModelStatus extends ModelDefinition {
  providerId?: string;
  providerName?: string;
  isDownloaded: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  downloadedSize: number;
  totalSize: number;
  path: string | null;
}

export type LocalLLMDownloadProgressEvent =
  | {
      type?: "progress";
      modelId: string;
      progress: number;
      downloadedSize: number;
      totalSize: number;
      sequence?: number;
    }
  | {
      type: "complete";
      modelId: string;
      progress: 100;
      downloadedSize?: number;
      totalSize?: number;
      sequence?: number;
    }
  | {
      type: "error";
      modelId: string;
      error: string;
      code?: string;
      details?: unknown;
      sequence?: number;
    };

export interface ConversationCreateSnapshot {
  client_conversation_id?: string | null;
  title: string;
  updated_at: string;
  message_count: number;
}

export interface ConversationCreateAckResult {
  success: boolean;
  outcome: "synced" | "changed" | "already-linked" | "delete-pending" | "orphaned" | "unresolved";
  cloud_id?: string | null;
}

export type OnboardingDemoKind = "dictation" | "assistant";
/**
 * "partial" streams the transcript, "processing" carries the final transcript,
 * "replying" streams the assistant demo's reply, and "level" mirrors the
 * microphone level while listening.
 */
export type OnboardingDemoStatus =
  "listening" | "level" | "processing" | "partial" | "replying" | "success" | "error";
export interface OnboardingDemoEvent {
  demoId: string;
  kind: OnboardingDemoKind;
  status: OnboardingDemoStatus;
  text?: string;
  message?: string;
  /** Tool the assistant is running while it replies (a tool registry name). */
  tool?: string;
  /** Microphone input level, 0..1, on "level" events. */
  level?: number;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      setOnboardingWindowMode?: (mode: "compact" | "expanded" | "restore") => Promise<boolean>;
      setOnboardingActive?: (active: boolean) => Promise<boolean>;

      // Database operations
      saveTranscription: (
        text: string,
        rawText?: string | null,
        options?: {
          status?: TranscriptionStatus;
          errorMessage?: string | null;
          errorCode?: TranscriptionErrorCode;
          clientTranscriptionId?: string;
          analyticsOccurredAt?: string;
        }
      ) => Promise<{ id: number; success: boolean; transcription?: TranscriptionItem }>;
      getTranscriptions: (
        limit?: number,
        options?: { includeDiscarded?: boolean }
      ) => Promise<TranscriptionItem[]>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      getTranscriptionById: (id: number) => Promise<TranscriptionItem | null>;

      // Audio retention operations
      saveTranscriptionAudio: (
        id: number,
        audioBuffer: ArrayBuffer,
        metadata?: { durationMs?: number; provider?: string; model?: string }
      ) => Promise<{ success: boolean; path?: string }>;
      mergeAudioSegments: (
        segments: Array<{ buffer: ArrayBuffer; mimeType: string }>
      ) => Promise<
        | { success: true; buffer: ArrayBuffer; mimeType: "audio/webm" }
        | { success: false; error: string }
      >;
      getAudioPath: (id: number) => Promise<string | null>;
      showAudioInFolder: (id: number) => Promise<{ success: boolean }>;
      getAudioBuffer: (id: number) => Promise<ArrayBuffer | null>;
      deleteTranscriptionAudio: (id: number) => Promise<{ success: boolean }>;
      getAudioStorageUsage: () => Promise<{ fileCount: number; totalBytes: number }>;
      deleteAllAudio: () => Promise<{ deleted: number }>;
      syncRetentionSettings?: (settings: {
        audioRetentionDays: number;
        transcriptRetentionDays: number;
        dataRetentionEnabled: boolean;
        localHistoryPolicyResolved: boolean;
      }) => void;
      updateTranscriptionText: (
        id: number,
        text: string,
        rawText: string
      ) => Promise<{ success: boolean; transcription?: TranscriptionItem; error?: string }>;

      // Vocabulary operations come from the shared VocabularyApi contract
      // (six renderer operations + the two subscriptions); dictionary export
      // stays local.

      // Container (folders/spaces) operations come from the shared
      // ContainersApi contract (eight operations + onFolderDeleted);
      // onSpacePurged has no producer and is not exposed.

      // Note operations come from the shared NotesApi contract (seven
      // operations + the three note subscriptions); note export stays local.
      exportNote: (
        noteId: number,
        format: "txt" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportTranscript: (
        noteId: number,
        format: "txt" | "srt" | "json" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportDictionary: (words: string[]) => Promise<{ success: boolean; error?: string }>;

      // Note files / Granola import commands come from the shared
      // NoteFilesApi contract.

      selectAudioFile: (options?: { multiple?: boolean }) => Promise<{
        canceled: boolean;
        filePath?: string;
        filePaths?: string[];
      }>;
      getFileSize?: (filePath: string) => Promise<number>;
      getPathForFile: (file: File) => string;

      // URL audio download operations come from the shared UrlDownloadApi
      // contract (three operations + the progress subscription).
      onFolderDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionUpdated?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;

      // API key management
      getOpenAIKey: () => Promise<string>;
      saveOpenAIKey: (key: string) => Promise<{ success: boolean }>;
      getAnthropicKey: () => Promise<string | null>;
      saveAnthropicKey: (key: string) => Promise<void>;
      getUiLanguage: () => Promise<string>;
      saveUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      setUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      saveAllKeysToEnv: () => Promise<{ success: boolean; path: string }>;
      syncStartupPreferences: (prefs: {
        useLocalWhisper: boolean;
        localTranscriptionProvider: LocalTranscriptionProvider;
        model?: string;
        language?: string;
        useCleanupModel: boolean;
        cleanupMode: InferenceMode;
        cleanupModel?: string;
      }) => Promise<void>;

      // Clipboard operations
      checkAccessibilityPermission: (silent?: boolean) => Promise<boolean>;
      promptAccessibilityPermission: () => Promise<boolean>;
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;

      // Audio

      // Whisper/Parakeet model lifecycle (downloads, status, servers, VAD
      // config, diagnostics) comes from the LocalModelLifecycleApi contract.

      // Local LLM model management (catalog, downloads, llama.cpp installer
      // checks, llama-server lifecycle) comes from the LocalLlmModelsApi
      // contract.

      // Local/Anthropic/enterprise one-shot reasoning, the Bedrock cleanup
      // cancel and the enterprise stream lifecycle come from the shared
      // ReasoningApi contract.



      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      snapToMeetingMode: () => Promise<void>;
      restoreFromMeetingMode: () => Promise<void>;
      getPlatform: () => string;
      startControlPanelDrag: () => Promise<void>;
      stopControlPanelDrag: () => Promise<void>;
      setNotificationInteractivity: (interactive: boolean) => Promise<void>;

      // App management
      cleanupApp: () => Promise<{ success: boolean; message: string; errors?: string[] }>;

      getOAuthProtocolRegistered: () => Promise<boolean>;
      getOAuthProtocol: () => Promise<string>;
      getAppVersion: () => Promise<{ version: string }>;

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
      setHotkeyListeningMode?: (enabled: boolean) => Promise<{ success: boolean }>;
      getHotkeyModeInfo?: (hotkey?: string) => Promise<{
        isUsingGnome: boolean;
        isUsingHyprland: boolean;
        isUsingKDE: boolean;
        isUsingNativeShortcut: boolean;
        supportsPushToTalk: boolean;
        pushToTalkUnavailableReason: string | null;
      }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;
      onGlobeKeyReleased?: (callback: () => void) => () => void;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;
      onSettingUpdated?: (callback: (data: { key: string; value: unknown }) => void) => () => void;

      // Settings shortcut (Cmd+, / Ctrl+,)
      onShowSettings?: (callback: () => void) => () => void;
      onAccessibilityMissing?: (callback: () => void) => () => void;

      // Gemini API key management
      getGeminiKey: () => Promise<string | null>;
      saveGeminiKey: (key: string) => Promise<void>;

      // Groq API key management
      getGroqKey: () => Promise<string | null>;
      saveGroqKey: (key: string) => Promise<void>;
      getOpenrouterKey: () => Promise<string | null>;
      saveOpenrouterKey: (key: string) => Promise<void>;

      // xAI API key management
      getXaiKey?: () => Promise<string | null>;
      saveXaiKey?: (key: string) => Promise<void>;

      // Mistral API key management
      getMistralKey: () => Promise<string | null>;
      saveMistralKey: (key: string) => Promise<void>;

      // Corti credential management
      getCortiClientId?: () => Promise<string | null>;
      saveCortiClientId?: (key: string) => Promise<void>;
      getCortiClientSecret?: () => Promise<string | null>;
      saveCortiClientSecret?: (key: string) => Promise<void>;
      getCortiKey?: () => Promise<string | null>;
      saveCortiKey?: (key: string) => Promise<void>;
      getTinfoilKey?: () => Promise<string | null>;
      saveTinfoilKey?: (key: string) => Promise<void>;
      getDeepgramKey?: () => Promise<string | null>;
      saveDeepgramKey?: (key: string) => Promise<void>;
      getAssemblyAIKey?: () => Promise<string | null>;
      saveAssemblyAIKey?: (key: string) => Promise<void>;

      // Custom endpoint API keys
      getCustomTranscriptionKey?: () => Promise<string | null>;
      saveCustomTranscriptionKey?: (key: string) => Promise<void>;
      getCleanupCustomKey?: () => Promise<string | null>;
      saveCleanupCustomKey?: (key: string) => Promise<void>;
      getNoteFormattingCustomKey?: () => Promise<string | null>;
      saveNoteFormattingCustomKey?: (key: string) => Promise<void>;
      getChatAgentCustomKey?: () => Promise<string | null>;
      saveChatAgentCustomKey?: (key: string) => Promise<void>;

      // Enterprise provider key persistence
      getBedrockRegion?: () => Promise<string | null>;
      saveBedrockRegion?: (value: string) => Promise<void>;
      getBedrockProfile?: () => Promise<string | null>;
      saveBedrockProfile?: (value: string) => Promise<void>;
      getBedrockAccessKeyId?: () => Promise<string | null>;
      saveBedrockAccessKeyId?: (key: string) => Promise<void>;
      getBedrockSecretAccessKey?: () => Promise<string | null>;
      saveBedrockSecretAccessKey?: (key: string) => Promise<void>;
      getBedrockSessionToken?: () => Promise<string | null>;
      saveBedrockSessionToken?: (key: string) => Promise<void>;
      getAzureEndpoint?: () => Promise<string | null>;
      saveAzureEndpoint?: (value: string) => Promise<void>;
      getAzureApiKey?: () => Promise<string | null>;
      saveAzureApiKey?: (key: string) => Promise<void>;
      getAzureDeployment?: () => Promise<string | null>;
      saveAzureDeployment?: (value: string) => Promise<void>;
      getAzureApiVersion?: () => Promise<string | null>;
      saveAzureApiVersion?: (value: string) => Promise<void>;
      getVertexProject?: () => Promise<string | null>;
      saveVertexProject?: (value: string) => Promise<void>;
      getVertexLocation?: () => Promise<string | null>;
      saveVertexLocation?: (value: string) => Promise<void>;
      getVertexApiKey?: () => Promise<string | null>;
      saveVertexApiKey?: (key: string) => Promise<void>;
      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;
      saveActivationMode?: (mode: "tap" | "push") => Promise<void>;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getDebugState: () => Promise<{
        enabled: boolean;
        logPath: string | null;
        logLevel: string;
      }>;
      setDebugLogging: (enabled: boolean) => Promise<{
        success: boolean;
        enabled?: boolean;
        logPath?: string | null;
        error?: string;
      }>;
      openLogsFolder: () => Promise<{ success: boolean; error?: string }>;

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      // getAudioDiagnostics comes from the LocalModelLifecycleApi contract.

      // System settings helpers
      requestMicrophoneAccess?: () => Promise<{ granted: boolean }>;
      checkMicrophoneAccess?: () => Promise<{ granted: boolean; status: string }>;
      getSystemDefaultMicrophone?: (options?: { refresh?: boolean }) => Promise<{
        name: string;
        nativeId?: string;
        platform: string;
        source: "system" | "unavailable";
      }>;
      checkSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      requestSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      openSystemAudioSettings?: () => Promise<{ success: boolean; error?: string }>;
      openScreenRecordingSettings?: () => Promise<{ success: boolean; error?: string }>;
      openLoginItemsSettings?: () => Promise<{ success: boolean; error?: string }>;
      showEmojiPanel?: () => Promise<boolean>;
      getModelCacheRoot?: () => Promise<string>;
      openWhisperModelsFolder?: () => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      registerMeetingHotkey?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
      notifyFloatingIconAutoHideChanged?: (enabled: boolean) => void;
      onFloatingIconAutoHideChanged?: (callback: (enabled: boolean) => void) => () => void;
      notifyStartMinimizedChanged?: (enabled: boolean) => void;
      notifyPanelStartPositionChanged?: (position: string) => void;
      onMainWindowHorizontalDirectionChanged?: (
        callback: (direction: "left" | "right") => void
      ) => () => void;
      onMainWindowWillResize?: (
        callback: (resize: {
          bounds: Electron.Rectangle;
          anchor: "bottom-left" | "bottom-right" | "center";
        }) => void
      ) => () => void;

      // Auto-start at login. requiresApproval is macOS-only: SMAppService can
      // register the login item and still leave it awaiting approval in System
      // Settings, which otherwise looks like a toggle that will not stick.
      getAutoStartEnabled?: () => Promise<{ enabled: boolean; requiresApproval: boolean }>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // BYOK audio file transcription, file diarization, speaker-text merge
      // and the hard cancel of one upload execution come from the shared
      // UploadTranscriptionApi contract (four channels).

      // Google Calendar commands/events live in the shared
      // CalendarIntegrationApi contract (availability has its own bridge).


      getMD5Hash: (text: string) => Promise<string>;

      // Meeting transcription (streaming, dual-channel)
      meetingTranscriptionPrepare?: (options: {
        provider?: string;
        model?: string;
        language?: string;
      }) => Promise<{ success: boolean; alreadyPrepared?: boolean } & PolicyFailureMetadata>;
      meetingTranscriptionStart?: (options: {
        provider?: string;
        model?: string;
        language?: string;
        noteId?: number | null;
        sessionId: string;
        autoEndEligible: boolean;
      }) => Promise<
        {
          success: boolean;
          sessionId?: string;
          error?: string;
          systemAudioMode?: SystemAudioMode;
          systemAudioStrategy?: SystemAudioStrategy;
          oneOnOneAttendee?: { displayName: string; email: string | null } | null;
        } & PolicyFailureMetadata
      >;
      meetingTranscriptionSend?: (buffer: ArrayBuffer, source: "mic" | "system") => void;
      meetingTranscriptionSetSystemAudioAvailable?: (
        sessionId: string,
        available: boolean
      ) => Promise<{ success: boolean; reason?: "stale-session" }>;
      meetingTranscriptionStop?: (expectedSessionId?: string) => Promise<{
        success: boolean;
        transcript?: string;
        diarizationSessionId?: string;
        error?: string;
        reason?: "stale-session";
      }>;
      meetingTranscriptionCancel?: () => Promise<{
        success: boolean;
        reason?: "recording-active";
      }>;
      onMeetingTranscriptionSegment?: (
        callback: (data: {
          text: string;
          source: "mic" | "system";
          type: "partial" | "final" | "retract";
          timestamp?: number;
        }) => void
      ) => () => void;
      onMeetingSpeakerIdentified?: (
        callback: (data: {
          speakerId: string;
          displayName?: string | null;
          startTime: number;
          endTime: number;
        }) => void
      ) => () => void;
      onMeetingSpeakersMerged?: (
        callback: (
          merges: Array<{
            keep: string;
            remove: string;
            displayName?: string | null;
            similarity: number;
          }>
        ) => void
      ) => () => void;
      onMeetingSessionSpeakerConfigUpdated?: (
        callback: (config: { enabled: boolean; expectedCount: number }) => void
      ) => () => void;
      onMeetingTranscriptionError?: (callback: (error: string) => void) => () => void;
      onMeetingTranscriptionFatalError?: (callback: (error: string) => void) => () => void;
      onMeetingSystemAudioSilent?: (
        callback: (data: { systemAudioStrategy: SystemAudioStrategy }) => void
      ) => () => void;
      onMeetingSystemAudioDegraded?: (callback: () => void) => () => void;
      onMeetingSystemAudioInterrupted?: (
        callback: (data: MeetingSystemAudioInterruption) => void
      ) => () => void;
      onMeetingSystemAudioResumed?: (callback: () => void) => () => void;

      // Diarization model management, the speaker mapping/profile/embedding
      // commands and contacts come from the shared SpeakerApi contract.
      // mergeSpeakerText and diarizeAudioFile come from the shared
      // UploadTranscriptionApi contract.
      onMeetingDiarizationComplete?: (
        callback: (data: {
          sessionId?: string;
          noteId?: number | null;
          segments: Array<{
            id: string;
            text: string;
            source: "mic" | "system";
            timestamp?: number;
            speaker?: string;
            speakerName?: string;
            speakerIsPlaceholder?: boolean;
            suggestedName?: string;
            suggestedProfileId?: number;
            speakerStatus?: "provisional" | "confirmed" | "suggested" | "locked";
            speakerLocked?: boolean;
            speakerLockSource?: "user" | "diarization" | "suggestion";
          }>;
          speakerEmbeddings?: Record<string, number[]> | null;
        }) => void
      ) => () => void;



      // Google/Microsoft/Apple Calendar commands and their six events come
      // from the shared CalendarIntegrationApi contract.

      meetingDetectionGetPreferences?: () => Promise<{ success: boolean; preferences?: any }>;
      meetingDetectionSetPreferences?: (
        prefs: Record<string, boolean>
      ) => Promise<{ success: boolean }>;
      syncNotificationPreferences?: (
        prefs: Record<string, boolean>
      ) => Promise<{ success: boolean }>;
      setSpeakerDiarizationEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      setMeetingSessionSpeakerConfig?: (config: {
        enabled: boolean;
        expectedCount: number;
        countIsExplicit?: boolean;
      }) => Promise<{ success: boolean; error?: string }>;
      // VAD config comes from the LocalModelLifecycleApi contract.
      onMeetingNotificationData?: (callback: (data: MeetingNotificationData) => void) => () => void;
      onMeetingAutoEndRequested?: (
        callback: (request: MeetingAutoEndRequest) => void
      ) => () => void;
      meetingAutoEndCompleted?: (sessionId: string) => Promise<MeetingAutoEndLifecycleResult>;
      meetingAutoEndRespond?: (
        sessionId: string,
        action: MeetingAutoEndAction
      ) => Promise<MeetingAutoEndLifecycleResult>;
      onMeetingAutoEndRestartRequested?: (
        callback: (request: MeetingAutoEndRestartRequest) => void
      ) => () => void;
      getMeetingNotificationData?: () => Promise<MeetingNotificationData | null>;
      meetingNotificationReady?: () => Promise<void>;
      meetingNotificationRespond?: (
        detectionId: string,
        action: string
      ) => Promise<{ success: boolean }>;
      joinCalendarMeeting?: (eventId: string) => Promise<{ success: boolean }>;
      getPendingMeetingNoteNavigation?: () => Promise<{
        noteId: number;
        folderId: number;
        event: any;
        trigger?: "hotkey" | "manual" | "calendar-join";
      } | null>;
      onMeetingNoteNavigationPending?: (callback: () => void) => () => void;
      getPendingNoteNavigation?: () => Promise<{
        noteId: number;
        folderId: number | null;
      } | null>;
      onNoteNavigationPending?: (callback: () => void) => () => void;
    } & NotesApi & UrlDownloadApi & VocabularyApi & ContainersApi & ChatPersistenceApi & ActionsApi & LocalFileTranscriptionApi & CalendarAvailabilityApi & UploadTranscriptionApi & ReasoningApi & CalendarIntegrationApi & NoteFilesApi & LocalModelLifecycleApi & LocalLlmModelsApi & SpeakerApi & TranscriptionExecutionApi & TranscriptionDataApi;

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
