import type { ModelDefinition } from "../models/ModelRegistry";
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
import type { DesktopSettingsApi } from "../contracts/desktopSettings";
import type { TranscriptionDataApi } from "../contracts/transcriptionData";

export type ChineseScriptPreference = "simplified" | "traditional" | "as-transcribed";

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
      // Onboarding/window controls, credentials, hotkeys, language, logging,
      // clipboard, permissions, cleanup and app metadata come from the shared
      // DesktopSettingsApi contract.


      // Vocabulary operations come from the shared VocabularyApi contract
      // (six renderer operations + the two subscriptions); dictionary export
      // stays local.

      // Container (folders/spaces) operations come from the shared
      // ContainersApi contract (eight operations + onFolderDeleted);
      // onSpacePurged has no producer and is not exposed.

      // Note operations come from the shared NotesApi contract (seven
      // operations + the three note subscriptions); note export stays local.

      // Note files / Granola import commands come from the shared
      // NoteFilesApi contract.

      getPathForFile: (file: File) => string;
      getPlatform: () => string;

      // URL audio download operations come from the shared UrlDownloadApi
      // contract (three operations + the progress subscription).
      onFolderDeleted?: (callback: (payload: { id: number }) => void) => () => void;


      // Audio

      // Whisper/Parakeet model lifecycle (downloads, status, servers, VAD
      // config, diagnostics) comes from the LocalModelLifecycleApi contract.

      // Local LLM model management (catalog, downloads, llama.cpp installer
      // checks, llama-server lifecycle) comes from the LocalLlmModelsApi
      // contract.

      // Local/Anthropic/enterprise one-shot reasoning, the Bedrock cleanup
      // cancel and the enterprise stream lifecycle come from the shared
      // ReasoningApi contract.



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

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      // getAudioDiagnostics comes from the LocalModelLifecycleApi contract.

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

      // BYOK audio file transcription, file diarization, speaker-text merge
      // and the hard cancel of one upload execution come from the shared
      // UploadTranscriptionApi contract (four channels).

      // Google Calendar commands/events live in the shared
      // CalendarIntegrationApi contract (availability has its own bridge).



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
    } & NotesApi & UrlDownloadApi & VocabularyApi & ContainersApi & ChatPersistenceApi & ActionsApi & LocalFileTranscriptionApi & CalendarAvailabilityApi & UploadTranscriptionApi & ReasoningApi & CalendarIntegrationApi & NoteFilesApi & LocalModelLifecycleApi & LocalLlmModelsApi & SpeakerApi & TranscriptionExecutionApi & TranscriptionDataApi & DesktopSettingsApi;

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
