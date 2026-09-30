// Single source of truth for the desktop/settings IPC boundary: onboarding and
// window controls, notification interactivity, BYOK + enterprise credentials,
// startup/hotkeys/activation mode, language, logging/debug, clipboard and
// external links, permissions/system settings, device cleanup, app/OAuth
// metadata and model folders. Channel names, arguments, results and errors are
// unchanged from the previous JS registrations.
import { z } from "zod";
import { BYOK_API_KEYS } from "../config/secretKeys.js";

// ---- shared wire shapes -----------------------------------------------------

export const saveKeyResultSchema = z
  .object({
    success: z.boolean(),
  })
  .passthrough();
export type SaveKeyWireResult = z.infer<typeof saveKeyResultSchema>;

export const simpleSuccessSchema = z.object({ success: z.boolean() });

// BYOK credential surface: the getter/setter names come verbatim from the
// shared manifest, so both sides are catalog-driven.
export type ByokGetterName = (typeof BYOK_API_KEYS)[number]["get"];
export type ByokSetterName = (typeof BYOK_API_KEYS)[number]["save"];

export type ByokKeySurface = {
  [name in ByokGetterName]: () => Promise<string>;
} & {
  [name in ByokSetterName]: (key: string) => Promise<SaveKeyWireResult>;
};

// ---- onboarding / window ----------------------------------------------------

export const onboardingWindowModeSchema = z.enum(["compact", "expanded", "restore"]);

export const openExternalResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// ---- hotkeys ------------------------------------------------------------------

export const hotkeyModeInfoSchema = z.object({
  isUsingGnome: z.boolean(),
  isUsingHyprland: z.boolean(),
  isUsingKDE: z.boolean(),
  isUsingNativeShortcut: z.boolean(),
  supportsPushToTalk: z.boolean(),
  pushToTalkUnavailableReason: z.string().nullable(),
});

export const hotkeyListeningResultSchema = z
  .object({
    success: z.boolean(),
    skipped: z.boolean().optional(),
  })
  .passthrough();

export const activationModeSchema = z.enum(["tap", "push"]);

// ---- startup / language / logging -----------------------------------------------

export const startupPreferencesSchema = z.object({
  useLocalWhisper: z.boolean().optional(),
  localTranscriptionProvider: z.string().optional(),
  model: z.string().optional(),
  language: z.string().optional(),
  useCleanupModel: z.boolean().optional(),
  cleanupMode: z.string().optional(),
  cleanupModel: z.string().optional(),
});

export const uiLanguageResultSchema = z
  .object({
    success: z.boolean(),
    language: z.string(),
  })
  .passthrough();

export const debugStateSchema = z.object({
  enabled: z.boolean(),
  logPath: z.string().nullable(),
  logLevel: z.string(),
});

export const setDebugLoggingResultSchema = z.object({
  success: z.boolean(),
  enabled: z.boolean().optional(),
  logPath: z.string().nullable().optional(),
  error: z.string().optional(),
});

// ---- permissions / system settings -----------------------------------------------

export const systemSettingsResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const microphoneAccessRequestSchema = z.object({
  granted: z.boolean(),
});

export const microphoneAccessStatusSchema = z.object({
  granted: z.boolean(),
  status: z.string(),
});

export type AccessStatusWire =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown"
  | "unsupported";
export type SystemAudioModeWire = "native" | "loopback" | "portal" | "unsupported";
export type SystemAudioStrategyWire =
  | "native"
  | "loopback"
  | "pipewire-loopback"
  | "wasapi-loopback"
  | "unsupported";

export const systemAudioAccessSchema = z
  .object({
    granted: z.boolean(),
    status: z.enum([
      "granted",
      "denied",
      "not-determined",
      "restricted",
      "unknown",
      "unsupported",
    ]),
    mode: z.enum(["native", "loopback", "portal", "unsupported"]),
    supportsPersistentGrant: z.boolean().optional(),
    supportsPersistentPortalGrant: z.boolean().optional(),
    supportsNativeCapture: z.boolean().optional(),
    supportsOnboardingGrant: z.boolean().optional(),
    requiresRuntimeSharePrompt: z.boolean().optional(),
    strategy: z.enum([
      "native",
      "loopback",
      "pipewire-loopback",
      "wasapi-loopback",
      "unsupported",
    ]).optional(),
    restoreTokenAvailable: z.boolean().optional(),
    portalVersion: z.number().nullable().optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type SystemAudioAccessWire = z.infer<typeof systemAudioAccessSchema>;

export const systemDefaultMicrophoneSchema = z
  .object({
    name: z.string(),
    nativeId: z.string().optional(),
    platform: z.string(),
    source: z.enum(["system", "unavailable"]),
  })
  .passthrough();

// ---- cleanup / app metadata --------------------------------------------------------

export const cleanupAppResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  errors: z.array(z.string()).optional(),
});

export const appVersionSchema = z.object({
  version: z.string(),
});

// ---- enterprise connection ----------------------------------------------------------

export const enterpriseConnectionWireSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    messageKey: z.string().optional(),
    messageParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    action: z.string().optional(),
    actionKey: z.string().optional(),
    copyCommand: z.string().optional(),
    retryable: z.boolean().optional(),
    technicalDetails: z.unknown().optional(),
  })
  .passthrough();

// ---- notification preferences ----------------------------------------------------------

export const notificationPreferencesSchema = z.object({
  notificationsEnabled: z.boolean().optional(),
  notifyMeetingDetection: z.boolean().optional(),
  notifyCalendarReminders: z.boolean().optional(),
});

// ---- channels ----------------------------------------------------------------------------

export const desktopSettingsChannels = {
  setOnboardingWindowMode: "onboarding-set-window-mode",
  setOnboardingActive: "onboarding-set-active",
  windowMinimize: "window-minimize",
  windowMaximize: "window-maximize",
  windowClose: "window-close",
  windowIsMaximized: "window-is-maximized",
  snapToMeetingMode: "snap-to-meeting-mode",
  restoreFromMeetingMode: "restore-from-meeting-mode",
  setNotificationInteractivity: "set-notification-interactivity",
  saveAllKeysToEnv: "save-all-keys-to-env",
  setCortiClientId: "save-corti-client-id",
  getCortiClientId: "get-corti-client-id",
  setCortiClientSecret: "save-corti-client-secret",
  getCortiClientSecret: "get-corti-client-secret",
  setCustomTranscriptionKey: "save-custom-transcription-key",
  getCustomTranscriptionKey: "get-custom-transcription-key",
  setCleanupCustomKey: "save-cleanup-custom-key",
  getCleanupCustomKey: "get-cleanup-custom-key",
  setBedrockRegion: "save-bedrock-region",
  getBedrockRegion: "get-bedrock-region",
  setBedrockProfile: "save-bedrock-profile",
  getBedrockProfile: "get-bedrock-profile",
  setBedrockAccessKeyId: "save-bedrock-access-key-id",
  getBedrockAccessKeyId: "get-bedrock-access-key-id",
  setBedrockSecretAccessKey: "save-bedrock-secret-access-key",
  getBedrockSecretAccessKey: "get-bedrock-secret-access-key",
  setBedrockSessionToken: "save-bedrock-session-token",
  getBedrockSessionToken: "get-bedrock-session-token",
  setAzureEndpoint: "save-azure-endpoint",
  getAzureEndpoint: "get-azure-endpoint",
  setAzureApiKey: "save-azure-api-key",
  getAzureApiKey: "get-azure-api-key",
  setAzureDeployment: "save-azure-deployment",
  getAzureDeployment: "get-azure-deployment",
  setAzureApiVersion: "save-azure-api-version",
  getAzureApiVersion: "get-azure-api-version",
  setVertexProject: "save-vertex-project",
  getVertexProject: "get-vertex-project",
  setVertexLocation: "save-vertex-location",
  getVertexLocation: "get-vertex-location",
  setVertexApiKey: "save-vertex-api-key",
  getVertexApiKey: "get-vertex-api-key",
  setHotkeyListeningMode: "set-hotkey-listening-mode",
  getHotkeyModeInfo: "get-hotkey-mode-info",
  registerCancelHotkey: "register-cancel-hotkey",
  unregisterCancelHotkey: "unregister-cancel-hotkey",
  getEffectiveDefaultHotkey: "get-effective-default-hotkey",
  getActivationMode: "get-activation-mode",
  saveActivationMode: "save-activation-mode",
  startControlPanelDrag: "start-control-panel-drag",
  stopControlPanelDrag: "stop-control-panel-drag",
  openExternal: "open-external",
  getAutoStartEnabled: "get-auto-start-enabled",
  setAutoStartEnabled: "set-auto-start-enabled",
  syncStartupPreferences: "sync-startup-preferences",
  getUiLanguage: "get-ui-language",
  saveUiLanguage: "save-ui-language",
  setUiLanguage: "set-ui-language",
  setTimeFormat: "set-time-format",
  getLogLevel: "get-log-level",
  log: "app-log",
  getDebugState: "get-debug-state",
  setDebugLogging: "set-debug-logging",
  openLogsFolder: "open-logs-folder",
  installAgentCli: "install-agent-cli",
  openMicrophoneSettings: "open-microphone-settings",
  openSoundInputSettings: "open-sound-input-settings",
  getSystemDefaultMicrophone: "get-system-default-microphone",
  openAccessibilitySettings: "open-accessibility-settings",
  openSystemAudioSettings: "open-system-audio-settings",
  openScreenRecordingSettings: "open-screen-recording-settings",
  openLoginItemsSettings: "open-login-items-settings",
  showEmojiPanel: "show-emoji-panel",
  requestMicrophoneAccess: "request-microphone-access",
  checkMicrophoneAccess: "check-microphone-access",
  checkSystemAudioAccess: "check-system-audio-access",
  requestSystemAudioAccess: "request-system-audio-access",
  checkAccessibilityPermission: "check-accessibility-permission",
  promptAccessibilityPermission: "prompt-accessibility-permission",
  readClipboard: "read-clipboard",
  writeClipboard: "write-clipboard",
  cleanupApp: "cleanup-app",
  getAppVersion: "get-app-version",
  getOAuthProtocolRegistered: "get-oauth-protocol-registered",
  getOAuthProtocol: "get-oauth-protocol",
  getModelCacheRoot: "get-model-cache-root",
  openWhisperModelsFolder: "open-whisper-models-folder",
  getMD5Hash: "get-md5-hash",
  syncNotificationPreferences: "sync-notification-preferences",
} as const;

// ---- renderer-facing surface -------------------------------------------------------------

export interface DesktopSettingsApi extends ByokKeySurface {
  setOnboardingWindowMode(mode: "compact" | "expanded" | "restore"): Promise<boolean>;
  setOnboardingActive(active: boolean): Promise<boolean>;
  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  windowIsMaximized(): Promise<boolean>;
  snapToMeetingMode(): Promise<void>;
  restoreFromMeetingMode(): Promise<void>;
  setNotificationInteractivity(interactive: boolean): Promise<SaveKeyWireResult>;
  saveAllKeysToEnv(): Promise<SaveKeyWireResult>;
  getCortiClientId(): Promise<string>;
  saveCortiClientId(key: string): Promise<SaveKeyWireResult>;
  getCortiClientSecret(): Promise<string>;
  saveCortiClientSecret(key: string): Promise<SaveKeyWireResult>;
  getCustomTranscriptionKey(): Promise<string>;
  saveCustomTranscriptionKey(key: string): Promise<SaveKeyWireResult>;
  getCleanupCustomKey(): Promise<string>;
  saveCleanupCustomKey(key: string): Promise<SaveKeyWireResult>;
  getBedrockRegion(): Promise<string>;
  saveBedrockRegion(value: string): Promise<SaveKeyWireResult>;
  getBedrockProfile(): Promise<string>;
  saveBedrockProfile(value: string): Promise<SaveKeyWireResult>;
  getBedrockAccessKeyId(): Promise<string>;
  saveBedrockAccessKeyId(key: string): Promise<SaveKeyWireResult>;
  getBedrockSecretAccessKey(): Promise<string>;
  saveBedrockSecretAccessKey(key: string): Promise<SaveKeyWireResult>;
  getBedrockSessionToken(): Promise<string>;
  saveBedrockSessionToken(key: string): Promise<SaveKeyWireResult>;
  getAzureEndpoint(): Promise<string>;
  saveAzureEndpoint(value: string): Promise<SaveKeyWireResult>;
  getAzureApiKey(): Promise<string>;
  saveAzureApiKey(key: string): Promise<SaveKeyWireResult>;
  getAzureDeployment(): Promise<string>;
  saveAzureDeployment(value: string): Promise<SaveKeyWireResult>;
  getAzureApiVersion(): Promise<string>;
  saveAzureApiVersion(value: string): Promise<SaveKeyWireResult>;
  getVertexProject(): Promise<string>;
  saveVertexProject(value: string): Promise<SaveKeyWireResult>;
  getVertexLocation(): Promise<string>;
  saveVertexLocation(value: string): Promise<SaveKeyWireResult>;
  getVertexApiKey(): Promise<string>;
  saveVertexApiKey(key: string): Promise<SaveKeyWireResult>;
  setHotkeyListeningMode(enabled: boolean): Promise<HotkeyListeningWireResult>;
  getHotkeyModeInfo(hotkey?: string): Promise<HotkeyModeInfoWire>;
  registerCancelHotkey(key: string): Promise<unknown>;
  unregisterCancelHotkey(): Promise<SaveKeyWireResult>;
  getEffectiveDefaultHotkey(): Promise<string | null>;
  getActivationMode(): Promise<"tap" | "push">;
  saveActivationMode(mode: "tap" | "push"): Promise<SaveKeyWireResult>;
  startControlPanelDrag(): Promise<unknown>;
  stopControlPanelDrag(): Promise<unknown>;
  openExternal(url: string): Promise<OpenExternalWireResult>;
  getAutoStartEnabled(): Promise<AutoStartStateWire>;
  setAutoStartEnabled(enabled: boolean): Promise<AutoStartSetResultWire>;
  syncStartupPreferences(prefs: {
    useLocalWhisper: boolean;
    localTranscriptionProvider: string;
    model?: string;
    language?: string;
    useCleanupModel: boolean;
    cleanupMode: string;
    cleanupModel?: string;
  }): Promise<void>;
  getUiLanguage(): Promise<string>;
  saveUiLanguage(language: string): Promise<UiLanguageWireResult>;
  setTimeFormat(format: "locale" | "12h" | "24h"): Promise<{ success: boolean }>;
  setUiLanguage(language: string): Promise<UiLanguageWireResult>;
  getLogLevel(): Promise<string>;
  log(entry: {
    level: string;
    message: string;
    meta?: unknown;
    scope?: string;
    source?: string;
  }): Promise<SaveKeyWireResult>;
  getDebugState(): Promise<DebugStateWire>;
  setDebugLogging(enabled: boolean): Promise<SetDebugLoggingWire>;
  openLogsFolder(): Promise<SystemSettingsWire>;
  installAgentCli(): Promise<SystemSettingsWire>;
  openMicrophoneSettings(): Promise<SystemSettingsWire>;
  openSoundInputSettings(): Promise<SystemSettingsWire>;
  getSystemDefaultMicrophone(options?: {
    refresh?: boolean;
  }): Promise<SystemDefaultMicrophoneWire>;
  openAccessibilitySettings(): Promise<SystemSettingsWire>;
  openSystemAudioSettings(): Promise<SystemSettingsWire>;
  openScreenRecordingSettings(): Promise<SystemSettingsWire>;
  openLoginItemsSettings(): Promise<SystemSettingsWire>;
  showEmojiPanel(): Promise<boolean>;
  requestMicrophoneAccess(): Promise<MicrophoneAccessWire>;
  checkMicrophoneAccess(): Promise<MicrophoneStatusWire>;
  checkSystemAudioAccess(): Promise<SystemAudioWire>;
  requestSystemAudioAccess(): Promise<SystemAudioWire>;
  checkAccessibilityPermission(silent?: boolean): Promise<boolean>;
  promptAccessibilityPermission(): Promise<boolean>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<SaveKeyWireResult>;
  cleanupApp(): Promise<CleanupAppWire>;
  getAppVersion(): Promise<AppVersionWire>;
  getOAuthProtocolRegistered(): Promise<boolean>;
  getOAuthProtocol(): Promise<string>;
  getModelCacheRoot(): Promise<string>;
  openWhisperModelsFolder(): Promise<SystemSettingsWire>;
  getMD5Hash(text: string): Promise<string>;
  syncNotificationPreferences(prefs: Record<string, boolean>): Promise<SaveKeyWireResult>;
}

export type HotkeyListeningWireResult = { success: boolean; skipped?: boolean };
export type HotkeyModeInfoWire = z.infer<typeof hotkeyModeInfoSchema>;
export type OpenExternalWireResult = z.infer<typeof openExternalResultSchema>;
export type AutoStartStateWire = { enabled: boolean; requiresApproval: boolean };
export type AutoStartSetResultWire = { success: boolean; error?: string };
export type UiLanguageWireResult = { success: boolean; language: string };
export type DebugStateWire = z.infer<typeof debugStateSchema>;
export type SetDebugLoggingWire = z.infer<typeof setDebugLoggingResultSchema>;
export type SystemSettingsWire = z.infer<typeof systemSettingsResultSchema>;
export type MicrophoneAccessWire = z.infer<typeof microphoneAccessRequestSchema>;
export type MicrophoneStatusWire = z.infer<typeof microphoneAccessStatusSchema>;
export type SystemAudioWire = z.infer<typeof systemAudioAccessSchema>;
export type SystemDefaultMicrophoneWire = z.infer<typeof systemDefaultMicrophoneSchema>;
export type CleanupAppWire = z.infer<typeof cleanupAppResultSchema>;
export type AppVersionWire = z.infer<typeof appVersionSchema>;
