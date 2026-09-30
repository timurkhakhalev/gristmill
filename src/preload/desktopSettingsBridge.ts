// Renderer-facing desktop/settings bridge. Moved out of preload.js so the
// window/credential/hotkey/language/debug/permission/metadata surfaces have
// one typed implementation backed by the shared contract, including the
// manifest-driven BYOK key methods. The sandboxed preload can't require local
// modules, so build-main.js bundles the final preload with esbuild.
import {
  desktopSettingsChannels,
  agentCliStatusSchema,
  activationModeSchema,
  hotkeyModeInfoSchema,
  hotkeyListeningResultSchema,
  onboardingWindowModeSchema,
  openExternalResultSchema,
  saveKeyResultSchema,
  simpleSuccessSchema,
  systemAudioAccessSchema,
  systemDefaultMicrophoneSchema,
  systemSettingsResultSchema,
  setDebugLoggingResultSchema,
  debugStateSchema,
  cleanupAppResultSchema,
  appVersionSchema,
  uiLanguageResultSchema,
  type ByokKeySurface,
  type DesktopSettingsApi,
  type SaveKeyWireResult,
} from "../contracts/desktopSettings.js";
import { BYOK_API_KEYS } from "../config/secretKeys.js";
import { z } from "zod";
import type { ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }
  return result.data;
}

// The return type is the shared DesktopSettingsApi, so any drift between this
// implementation and the contract fails compilation.
export function createDesktopSettingsBridge(ipcRenderer: IpcRendererLike): DesktopSettingsApi {
  const invokeParse = <T>(schema: ZodType<T>, channel: string, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args).then((raw) => parseResult(schema, raw, channel));
  const saveKey = (channel: string, value: unknown): Promise<SaveKeyWireResult> =>
    invokeParse(saveKeyResultSchema, channel, value);
  const getKey = (channel: string) =>
    ipcRenderer.invoke(channel).then((raw) => {
      if (typeof raw !== "string") {
        throw new Error(`Unexpected response shape from ${channel}`);
      }
      return raw;
    });

  // The BYOK key methods are generated from the shared manifest so adding a
  // provider is one entry; the seed cast only asserts the accumulator type
  // (same pattern as the generated accessors in environment.ts).
  const byokApi = BYOK_API_KEYS.reduce<ByokKeySurface>(
    (surface, k) => ({
      ...surface,
      [k.get]: () => getKey(`get-${k.base}-key`),
      [k.save]: (key: string) => saveKey(`save-${k.base}-key`, key),
    }),
    {} as ByokKeySurface
  );

  return {
    ...byokApi,
    setOnboardingWindowMode: (mode) =>
      ipcRenderer
        .invoke(desktopSettingsChannels.setOnboardingWindowMode, mode)
        .then((raw) => raw === true),
    setOnboardingActive: (active) =>
      ipcRenderer
        .invoke(desktopSettingsChannels.setOnboardingActive, active)
        .then((raw) => raw === true),
    windowMinimize: () => ipcRenderer.invoke(desktopSettingsChannels.windowMinimize).then(() => undefined),
    windowMaximize: () => ipcRenderer.invoke(desktopSettingsChannels.windowMaximize).then(() => undefined),
    windowClose: () => ipcRenderer.invoke(desktopSettingsChannels.windowClose).then(() => undefined),
    windowIsMaximized: () =>
      ipcRenderer.invoke(desktopSettingsChannels.windowIsMaximized).then((raw) => raw === true),
    snapToMeetingMode: () =>
      ipcRenderer.invoke(desktopSettingsChannels.snapToMeetingMode).then(() => undefined),
    restoreFromMeetingMode: () =>
      ipcRenderer.invoke(desktopSettingsChannels.restoreFromMeetingMode).then(() => undefined),
    setNotificationInteractivity: (interactive) =>
      invokeParse(
        saveKeyResultSchema,
        desktopSettingsChannels.setNotificationInteractivity,
        interactive
      ),
    saveAllKeysToEnv: () => invokeParse(saveKeyResultSchema, desktopSettingsChannels.saveAllKeysToEnv),
    getCortiClientId: () => getKey(desktopSettingsChannels.getCortiClientId),
    saveCortiClientId: (key) => saveKey(desktopSettingsChannels.setCortiClientId, key),
    getCortiClientSecret: () => getKey(desktopSettingsChannels.getCortiClientSecret),
    saveCortiClientSecret: (key) => saveKey(desktopSettingsChannels.setCortiClientSecret, key),
    getCustomTranscriptionKey: () => getKey(desktopSettingsChannels.getCustomTranscriptionKey),
    saveCustomTranscriptionKey: (key) =>
      saveKey(desktopSettingsChannels.setCustomTranscriptionKey, key),
    getCleanupCustomKey: () => getKey(desktopSettingsChannels.getCleanupCustomKey),
    saveCleanupCustomKey: (key) => saveKey(desktopSettingsChannels.setCleanupCustomKey, key),
    getBedrockRegion: () => getKey(desktopSettingsChannels.getBedrockRegion),
    saveBedrockRegion: (value) => saveKey(desktopSettingsChannels.setBedrockRegion, value),
    getBedrockProfile: () => getKey(desktopSettingsChannels.getBedrockProfile),
    saveBedrockProfile: (value) => saveKey(desktopSettingsChannels.setBedrockProfile, value),
    getBedrockAccessKeyId: () => getKey(desktopSettingsChannels.getBedrockAccessKeyId),
    saveBedrockAccessKeyId: (key) => saveKey(desktopSettingsChannels.setBedrockAccessKeyId, key),
    getBedrockSecretAccessKey: () => getKey(desktopSettingsChannels.getBedrockSecretAccessKey),
    saveBedrockSecretAccessKey: (key) =>
      saveKey(desktopSettingsChannels.setBedrockSecretAccessKey, key),
    getBedrockSessionToken: () => getKey(desktopSettingsChannels.getBedrockSessionToken),
    saveBedrockSessionToken: (key) => saveKey(desktopSettingsChannels.setBedrockSessionToken, key),
    getAzureEndpoint: () => getKey(desktopSettingsChannels.getAzureEndpoint),
    saveAzureEndpoint: (value) => saveKey(desktopSettingsChannels.setAzureEndpoint, value),
    getAzureApiKey: () => getKey(desktopSettingsChannels.getAzureApiKey),
    saveAzureApiKey: (key) => saveKey(desktopSettingsChannels.setAzureApiKey, key),
    getAzureDeployment: () => getKey(desktopSettingsChannels.getAzureDeployment),
    saveAzureDeployment: (value) => saveKey(desktopSettingsChannels.setAzureDeployment, value),
    getAzureApiVersion: () => getKey(desktopSettingsChannels.getAzureApiVersion),
    saveAzureApiVersion: (value) => saveKey(desktopSettingsChannels.setAzureApiVersion, value),
    getVertexProject: () => getKey(desktopSettingsChannels.getVertexProject),
    saveVertexProject: (value) => saveKey(desktopSettingsChannels.setVertexProject, value),
    getVertexLocation: () => getKey(desktopSettingsChannels.getVertexLocation),
    saveVertexLocation: (value) => saveKey(desktopSettingsChannels.setVertexLocation, value),
    getVertexApiKey: () => getKey(desktopSettingsChannels.getVertexApiKey),
    saveVertexApiKey: (key) => saveKey(desktopSettingsChannels.setVertexApiKey, key),
    setHotkeyListeningMode: (enabled) =>
      invokeParse(
        hotkeyListeningResultSchema,
        desktopSettingsChannels.setHotkeyListeningMode,
        enabled
      ),
    getHotkeyModeInfo: (hotkey) =>
      invokeParse(hotkeyModeInfoSchema, desktopSettingsChannels.getHotkeyModeInfo, hotkey),
    registerCancelHotkey: (key) =>
      ipcRenderer.invoke(desktopSettingsChannels.registerCancelHotkey, key),
    unregisterCancelHotkey: () =>
      invokeParse(simpleSuccessSchema, desktopSettingsChannels.unregisterCancelHotkey),
    getEffectiveDefaultHotkey: () =>
      ipcRenderer
        .invoke(desktopSettingsChannels.getEffectiveDefaultHotkey)
        .then((raw) => (typeof raw === "string" ? raw : null)),
    getActivationMode: () =>
      invokeParse(activationModeSchema, desktopSettingsChannels.getActivationMode),
    saveActivationMode: (mode) => saveKey(desktopSettingsChannels.saveActivationMode, mode),
    startControlPanelDrag: () => ipcRenderer.invoke(desktopSettingsChannels.startControlPanelDrag),
    stopControlPanelDrag: () => ipcRenderer.invoke(desktopSettingsChannels.stopControlPanelDrag),
    openExternal: (url) =>
      invokeParse(openExternalResultSchema, desktopSettingsChannels.openExternal, url),
    getAutoStartEnabled: () =>
      ipcRenderer
        .invoke(desktopSettingsChannels.getAutoStartEnabled)
        .then((raw) => parseResult(autoStartStateSchema, raw, "get-auto-start-enabled")),
    setAutoStartEnabled: (enabled) =>
      invokeParse(autoStartSetResultSchema, desktopSettingsChannels.setAutoStartEnabled, enabled),
    syncStartupPreferences: (prefs) =>
      ipcRenderer
        .invoke(desktopSettingsChannels.syncStartupPreferences, prefs)
        .then(() => undefined),
    getUiLanguage: () => getKey(desktopSettingsChannels.getUiLanguage),
    saveUiLanguage: (language) =>
      invokeParse(uiLanguageResultSchema, desktopSettingsChannels.saveUiLanguage, language),
    setTimeFormat: (format) => invokeParse(simpleSuccessSchema, desktopSettingsChannels.setTimeFormat, format),
    setUiLanguage: (language) =>
      invokeParse(uiLanguageResultSchema, desktopSettingsChannels.setUiLanguage, language),
    getLogLevel: () =>
      ipcRenderer.invoke(desktopSettingsChannels.getLogLevel).then((raw) => {
        if (typeof raw !== "string") {
          throw new Error("Unexpected response shape from get-log-level");
        }
        return raw;
      }),
    log: (entry) => invokeParse(saveKeyResultSchema, desktopSettingsChannels.log, entry),
    getDebugState: () =>
      invokeParse(debugStateSchema, desktopSettingsChannels.getDebugState),
    setDebugLogging: (enabled) =>
      invokeParse(setDebugLoggingResultSchema, desktopSettingsChannels.setDebugLogging, enabled),
    openLogsFolder: () =>
      invokeParse(systemSettingsResultSchema, desktopSettingsChannels.openLogsFolder),
    getAgentCliStatus: () =>
      invokeParse(agentCliStatusSchema, desktopSettingsChannels.getAgentCliStatus),
    installAgentCli: () =>
      invokeParse(systemSettingsResultSchema, desktopSettingsChannels.installAgentCli),
    openMicrophoneSettings: () =>
      invokeParse(systemSettingsResultSchema, desktopSettingsChannels.openMicrophoneSettings),
    openSoundInputSettings: () =>
      invokeParse(systemSettingsResultSchema, desktopSettingsChannels.openSoundInputSettings),
    getSystemDefaultMicrophone: (options) =>
      invokeParse(
        systemDefaultMicrophoneSchema,
        desktopSettingsChannels.getSystemDefaultMicrophone,
        options
      ),
    openAccessibilitySettings: () =>
      invokeParse(systemSettingsResultSchema, desktopSettingsChannels.openAccessibilitySettings),
    openSystemAudioSettings: () =>
      invokeParse(systemSettingsResultSchema, desktopSettingsChannels.openSystemAudioSettings),
    openScreenRecordingSettings: () =>
      invokeParse(systemSettingsResultSchema, desktopSettingsChannels.openScreenRecordingSettings),
    openLoginItemsSettings: () =>
      invokeParse(systemSettingsResultSchema, desktopSettingsChannels.openLoginItemsSettings),
    showEmojiPanel: () =>
      ipcRenderer.invoke(desktopSettingsChannels.showEmojiPanel).then((raw) => raw === true),
    requestMicrophoneAccess: () =>
      ipcRenderer
        .invoke(desktopSettingsChannels.requestMicrophoneAccess)
        .then((raw) => parseResult(microphoneAccessSchema, raw, "request-microphone-access")),
    checkMicrophoneAccess: () =>
      ipcRenderer
        .invoke(desktopSettingsChannels.checkMicrophoneAccess)
        .then((raw) => parseResult(microphoneStatusSchema, raw, "check-microphone-access")),
    checkSystemAudioAccess: () =>
      invokeParse(systemAudioAccessSchema, desktopSettingsChannels.checkSystemAudioAccess),
    requestSystemAudioAccess: () =>
      invokeParse(systemAudioAccessSchema, desktopSettingsChannels.requestSystemAudioAccess),
    checkAccessibilityPermission: (silent) =>
      ipcRenderer
        .invoke(desktopSettingsChannels.checkAccessibilityPermission, silent)
        .then((raw) => raw === true),
    promptAccessibilityPermission: () =>
      ipcRenderer
        .invoke(desktopSettingsChannels.promptAccessibilityPermission)
        .then((raw) => raw === true),
    readClipboard: () =>
      ipcRenderer.invoke(desktopSettingsChannels.readClipboard).then((raw) => {
        if (typeof raw !== "string") {
          throw new Error("Unexpected response shape from read-clipboard");
        }
        return raw;
      }),
    writeClipboard: (text) => invokeParse(saveKeyResultSchema, desktopSettingsChannels.writeClipboard, text),
    cleanupApp: () => invokeParse(cleanupAppResultSchema, desktopSettingsChannels.cleanupApp),
    getAppVersion: () => invokeParse(appVersionSchema, desktopSettingsChannels.getAppVersion),
    getOAuthProtocolRegistered: () =>
      ipcRenderer
        .invoke(desktopSettingsChannels.getOAuthProtocolRegistered)
        .then((raw) => raw === true),
    getOAuthProtocol: () =>
      ipcRenderer.invoke(desktopSettingsChannels.getOAuthProtocol).then((raw) => {
        if (typeof raw !== "string") {
          throw new Error("Unexpected response shape from get-oauth-protocol");
        }
        return raw;
      }),
    getModelCacheRoot: () =>
      ipcRenderer.invoke(desktopSettingsChannels.getModelCacheRoot).then((raw) => {
        if (typeof raw !== "string") {
          throw new Error("Unexpected response shape from get-model-cache-root");
        }
        return raw;
      }),
    openWhisperModelsFolder: () =>
      invokeParse(systemSettingsResultSchema, desktopSettingsChannels.openWhisperModelsFolder),
    getMD5Hash: (text) =>
      ipcRenderer.invoke(desktopSettingsChannels.getMD5Hash, text).then((raw) => {
        if (typeof raw !== "string") {
          throw new Error("Unexpected response shape from get-md5-hash");
        }
        return raw;
      }),
    syncNotificationPreferences: (prefs) =>
      invokeParse(simpleSuccessSchema, desktopSettingsChannels.syncNotificationPreferences, prefs),
  };
}

const autoStartStateSchema = z.object({
  enabled: z.boolean(),
  requiresApproval: z.boolean(),
});
const autoStartSetResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
const microphoneAccessSchema = z.object({ granted: z.boolean() });
const microphoneStatusSchema = z.object({ granted: z.boolean(), status: z.string() });
