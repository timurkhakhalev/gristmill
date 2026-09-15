// The desktop/settings IPC handlers, moved out of ipcHandlers.js: onboarding
// and window controls, notification interactivity, the credential surface
// (BYOK manifest, Corti, custom endpoints, enterprise providers), startup and
// hotkey preferences, language, logging/debug, clipboard and external links,
// permissions/system settings, device cleanup, app/OAuth metadata, model
// folders and hashing. Channels, arguments, results and errors are unchanged;
// untrusted payloads are parsed at the boundary and only validated values
// reach the managers.
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  shell,
  systemPreferences,
  type WebContents,
} from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import debugLogger from "./debugLogger.js";
import { getAutoStartState, setAutoStartEnabled } from "./autoStart.js";
import { openSystemSettings } from "./systemSettingsLauncher.js";
import { resolveSystemDefaultMicrophone } from "./systemDefaultMicrophone.js";
import { resolveLocalServerNeeds } from "./localServerPolicy.js";
import { isSherpaLocalProvider } from "./parakeetModelInfo.js";
import { changeLanguage } from "./i18nMain.js";
import { openExternalUrl } from "./externalUrlOpener.js";
import { BYOK_API_KEYS } from "../config/secretKeys.js";
import { getCacheRoot } from "./modelDirUtils.js";
import {
  desktopSettingsChannels,
  activationModeSchema,
  notificationPreferencesSchema,
  onboardingWindowModeSchema,
  startupPreferencesSchema,
  type ByokGetterName,
  type ByokSetterName,
  type SaveKeyWireResult,
} from "../contracts/desktopSettings.js";

type IpcEventListener = (event: unknown, ...args: unknown[]) => void;

export interface Logger {
  log: (message: string, data?: unknown) => void;
  debug: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown, tag?: string) => void;
  error: (message: string, data?: unknown, tag?: string) => void;
}

// The macOS hotkey-capture mode is module state: entering capture unregisters
// every globalShortcut slot, exiting re-registers the non-dictation slots.
let hotkeyCaptureMode = false;

export interface DesktopSettingsDeps {
  windowManager: {
    setOnboardingWindowMode: (mode: string) => boolean;
    setOnboardingActive: (active: unknown) => boolean;
    controlPanelWindow: BrowserWindow | null;
    snapControlPanelToMeetingMode: () => void;
    restoreControlPanelFromMeetingMode: () => void;
    setNotificationInteractivity: (sender: unknown, interactive: boolean) => void;
    setHotkeyListeningMode: (enabled: boolean) => void;
    isUsingNativeShortcutHotkeys: () => boolean;
    hotkeyManager: {
      slots: Map<
        string,
        {
          hotkeys?: string[];
          accelerators?: Array<string | null>;
          callback?: ((pressedHotkey?: string) => void) | null;
        }
      >;
      getCurrentHotkey: () => string | null;
      registerSlot: (
        slotName: string,
        hotkeys: unknown,
        callback: () => void
      ) => Promise<unknown>;
      unregisterSlot: (slotName: string) => void;
      supportsPushToTalk: (hotkey: string | null) => boolean;
      getPushToTalkUnavailableReason: (hotkey: string | null) => string;
      getEffectiveDefaultHotkey: () => string;
    };
    startControlPanelDrag: () => Promise<unknown>;
    stopControlPanelDrag: () => Promise<unknown>;
    notificationPrefs: Record<string, boolean>;
    refreshLocalizedUi?: () => void;
    mainWindow: BrowserWindow | null;
    sendToMainWindow?: (channel: string) => void;
  };
  // Meeting coordinator seams stay owned by the coordinator; these settings
  // channels only flip the two gates through narrow callbacks.
  setMeetingModeActive: (active: boolean) => void;
  setDetectionGateForNotifications: (enabled: boolean) => void;
  environment: {
    byokGet: (name: ByokGetterName) => string;
    byokSave: (name: ByokSetterName, key: string) => SaveKeyWireResult;
    getCortiClientId: () => string;
    saveCortiClientId: (key: string) => SaveKeyWireResult;
    getCortiClientSecret: () => string;
    saveCortiClientSecret: (key: string) => SaveKeyWireResult;
    getCustomTranscriptionKey: () => string;
    saveCustomTranscriptionKey: (key: string) => SaveKeyWireResult;
    getCleanupCustomKey: () => string;
    saveCleanupCustomKey: (key: string) => SaveKeyWireResult;
    getBedrockRegion: () => string;
    saveBedrockRegion: (value: string) => SaveKeyWireResult;
    getBedrockProfile: () => string;
    saveBedrockProfile: (value: string) => SaveKeyWireResult;
    getBedrockAccessKeyId: () => string;
    saveBedrockAccessKeyId: (key: string) => SaveKeyWireResult;
    getBedrockSecretAccessKey: () => string;
    saveBedrockSecretAccessKey: (key: string) => SaveKeyWireResult;
    getBedrockSessionToken: () => string;
    saveBedrockSessionToken: (key: string) => SaveKeyWireResult;
    getAzureEndpoint: () => string;
    saveAzureEndpoint: (value: string) => SaveKeyWireResult;
    getAzureApiKey: () => string;
    saveAzureApiKey: (key: string) => SaveKeyWireResult;
    getAzureDeployment: () => string;
    saveAzureDeployment: (value: string) => SaveKeyWireResult;
    getAzureApiVersion: () => string;
    saveAzureApiVersion: (value: string) => SaveKeyWireResult;
    getVertexProject: () => string;
    saveVertexProject: (value: string) => SaveKeyWireResult;
    getVertexLocation: () => string;
    saveVertexLocation: (value: string) => SaveKeyWireResult;
    getVertexApiKey: () => string;
    saveVertexApiKey: (key: string) => SaveKeyWireResult;
    getActivationMode: () => "push" | "tap";
    saveActivationMode: (mode: string) => SaveKeyWireResult;
    getUiLanguage: () => string;
    saveUiLanguage: (language: string) => SaveKeyWireResult & { language: string };
    saveAllKeysToEnvFile: () => Promise<unknown>;
    clearAllPersistedData: () => Promise<void>;
  };
  audioTap: {
    isSupported: () => boolean;
    checkAccess: () => { granted: boolean; status: string };
    requestAccess: () => Promise<{ granted: boolean }>;
    getPermissionStatus: () => string;
  };
  oauthProtocolRegistered: boolean;
  oauthProtocol: string;
  getTrayManager: () => { updateTrayMenu?: () => void } | null | undefined;
  sendToMainWindow: (channel: string) => void;
  // Local sidecar seams for startup preference switches.
  stopWhisperServer: () => Promise<void>;
  stopParakeetServer: () => Promise<void>;
  stopLlamaServer: () => Promise<void>;
  // Device cleanup seams — every manager-owned step stays behind a callback.
  cleanup: {
    stopParakeetServer: () => Promise<void>;
    stopWhisperServer: () => void;
    stopGoogleCalendar: () => void;
    stopMicrosoftCalendar: () => void;
    stopAppleCalendar: () => void;
    shutdownDiarization: () => Promise<void>;
    revokeGoogleTokens: () => Promise<void>;
    closeDatabase: () => void;
    deleteAllAudio: () => void;
    deleteWhisperModels: () => void;
    deleteParakeetModels: () => Promise<void>;
    deleteDiarizationModels: () => Promise<void>;
    deleteLlmModels: () => Promise<void>;
  };
  logger: Logger;
}

const NOTIFICATION_PREF_KEYS = new Set([
  "notificationsEnabled",
  "notifyMeetingDetection",
  "notifyCalendarReminders",
]);

// Syncs startup env vars and persists them to the .env file (moved from the
// IPCHandlers._syncStartupEnv helper).
function syncStartupEnv(
  deps: DesktopSettingsDeps,
  setVars: Record<string, string>,
  clearVars: string[] = []
): void {
  let changed = false;
  for (const [key, value] of Object.entries(setVars)) {
    if (process.env[key] !== value) {
      process.env[key] = value;
      changed = true;
    }
  }
  for (const key of clearVars) {
    if (process.env[key]) {
      delete process.env[key];
      changed = true;
    }
  }
  if (changed) {
    debugLogger.debug("Synced startup env vars", {
      set: Object.keys(setVars),
      cleared: clearVars.filter((k) => !process.env[k]),
    });
    // Log persistence failures with the exact keys that were requested.
    deps.environment.saveAllKeysToEnvFile().catch((err: Error) => {
      debugLogger.error("Failed to persist startup env vars to .env", {
        set: Object.keys(setVars),
        clearRequested: clearVars,
        error: err.message,
      });
    });
  }
}

export function registerDesktopSettingsHandlers(
  ipcMain: {
    handle(channel: string, listener: IpcEventListener): void;
    emit?: (event: string, ...args: unknown[]) => boolean;
  },
  deps: DesktopSettingsDeps
): void {
  const { logger, windowManager, environment } = deps;
  const hotkeyManager = windowManager.hotkeyManager;

  // ---- onboarding / window ------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.setOnboardingWindowMode, (_event, mode: unknown) => {
    const parsed = onboardingWindowModeSchema.safeParse(mode);
    if (!parsed.success) return false;
    return windowManager.setOnboardingWindowMode(parsed.data);
  });

  ipcMain.handle(desktopSettingsChannels.setOnboardingActive, (_event, active: unknown) => {
    if (typeof active !== "boolean") return false;
    return windowManager.setOnboardingActive(active);
  });

  ipcMain.handle(desktopSettingsChannels.windowMinimize, () => {
    if (windowManager.controlPanelWindow) {
      windowManager.controlPanelWindow.minimize();
    }
  });

  ipcMain.handle(desktopSettingsChannels.windowMaximize, () => {
    if (windowManager.controlPanelWindow) {
      if (windowManager.controlPanelWindow.isMaximized()) {
        windowManager.controlPanelWindow.unmaximize();
      } else {
        windowManager.controlPanelWindow.maximize();
      }
    }
  });

  ipcMain.handle(desktopSettingsChannels.windowClose, () => {
    if (windowManager.controlPanelWindow) {
      windowManager.controlPanelWindow.close();
    }
  });

  ipcMain.handle(desktopSettingsChannels.windowIsMaximized, () => {
    if (windowManager.controlPanelWindow) {
      return windowManager.controlPanelWindow.isMaximized();
    }
    return false;
  });

  ipcMain.handle(desktopSettingsChannels.snapToMeetingMode, () => {
    windowManager.snapControlPanelToMeetingMode();
  });

  ipcMain.handle(desktopSettingsChannels.restoreFromMeetingMode, () => {
    windowManager.restoreControlPanelFromMeetingMode();
    deps.setMeetingModeActive(false);
  });

  ipcMain.handle(desktopSettingsChannels.setNotificationInteractivity, (event, interactive) => {
    windowManager.setNotificationInteractivity(
      (event as { sender: unknown }).sender,
      Boolean(interactive)
    );
    return { success: true };
  });

  // ---- credentials: BYOK manifest -------------------------------------------------

  for (const k of BYOK_API_KEYS) {
    ipcMain.handle(`get-${k.base}-key`, () => environment.byokGet(k.get));
    ipcMain.handle(`save-${k.base}-key`, (_event, key: unknown) =>
      environment.byokSave(k.save, typeof key === "string" ? key : "")
    );
  }

  // ---- credentials: Corti / custom endpoints / enterprise providers ---------------

  ipcMain.handle(desktopSettingsChannels.getCortiClientId, () => environment.getCortiClientId());
  ipcMain.handle(desktopSettingsChannels.setCortiClientId, (_event, key: unknown) =>
    environment.saveCortiClientId(typeof key === "string" ? key : "")
  );
  ipcMain.handle(desktopSettingsChannels.getCortiClientSecret, () =>
    environment.getCortiClientSecret()
  );
  ipcMain.handle(desktopSettingsChannels.setCortiClientSecret, (_event, key: unknown) =>
    environment.saveCortiClientSecret(typeof key === "string" ? key : "")
  );

  ipcMain.handle(desktopSettingsChannels.getCustomTranscriptionKey, () =>
    environment.getCustomTranscriptionKey()
  );
  ipcMain.handle(desktopSettingsChannels.setCustomTranscriptionKey, (_event, key: unknown) =>
    environment.saveCustomTranscriptionKey(typeof key === "string" ? key : "")
  );
  ipcMain.handle(desktopSettingsChannels.getCleanupCustomKey, () =>
    environment.getCleanupCustomKey()
  );
  ipcMain.handle(desktopSettingsChannels.setCleanupCustomKey, (_event, key: unknown) =>
    environment.saveCleanupCustomKey(typeof key === "string" ? key : "")
  );

  ipcMain.handle(desktopSettingsChannels.getBedrockRegion, () => environment.getBedrockRegion());
  ipcMain.handle(desktopSettingsChannels.setBedrockRegion, (_event, value: unknown) =>
    environment.saveBedrockRegion(typeof value === "string" ? value : "")
  );
  ipcMain.handle(desktopSettingsChannels.getBedrockProfile, () => environment.getBedrockProfile());
  ipcMain.handle(desktopSettingsChannels.setBedrockProfile, (_event, value: unknown) =>
    environment.saveBedrockProfile(typeof value === "string" ? value : "")
  );
  ipcMain.handle(desktopSettingsChannels.getBedrockAccessKeyId, () =>
    environment.getBedrockAccessKeyId()
  );
  ipcMain.handle(desktopSettingsChannels.setBedrockAccessKeyId, (_event, key: unknown) =>
    environment.saveBedrockAccessKeyId(typeof key === "string" ? key : "")
  );
  ipcMain.handle(desktopSettingsChannels.getBedrockSecretAccessKey, () =>
    environment.getBedrockSecretAccessKey()
  );
  ipcMain.handle(desktopSettingsChannels.setBedrockSecretAccessKey, (_event, key: unknown) =>
    environment.saveBedrockSecretAccessKey(typeof key === "string" ? key : "")
  );
  ipcMain.handle(desktopSettingsChannels.getBedrockSessionToken, () =>
    environment.getBedrockSessionToken()
  );
  ipcMain.handle(desktopSettingsChannels.setBedrockSessionToken, (_event, key: unknown) =>
    environment.saveBedrockSessionToken(typeof key === "string" ? key : "")
  );
  ipcMain.handle(desktopSettingsChannels.getAzureEndpoint, () => environment.getAzureEndpoint());
  ipcMain.handle(desktopSettingsChannels.setAzureEndpoint, (_event, value: unknown) =>
    environment.saveAzureEndpoint(typeof value === "string" ? value : "")
  );
  ipcMain.handle(desktopSettingsChannels.getAzureApiKey, () => environment.getAzureApiKey());
  ipcMain.handle(desktopSettingsChannels.setAzureApiKey, (_event, key: unknown) =>
    environment.saveAzureApiKey(typeof key === "string" ? key : "")
  );
  ipcMain.handle(desktopSettingsChannels.getAzureDeployment, () =>
    environment.getAzureDeployment()
  );
  ipcMain.handle(desktopSettingsChannels.setAzureDeployment, (_event, value: unknown) =>
    environment.saveAzureDeployment(typeof value === "string" ? value : "")
  );
  ipcMain.handle(desktopSettingsChannels.getAzureApiVersion, () =>
    environment.getAzureApiVersion()
  );
  ipcMain.handle(desktopSettingsChannels.setAzureApiVersion, (_event, value: unknown) =>
    environment.saveAzureApiVersion(typeof value === "string" ? value : "")
  );
  ipcMain.handle(desktopSettingsChannels.getVertexProject, () => environment.getVertexProject());
  ipcMain.handle(desktopSettingsChannels.setVertexProject, (_event, value: unknown) =>
    environment.saveVertexProject(typeof value === "string" ? value : "")
  );
  ipcMain.handle(desktopSettingsChannels.getVertexLocation, () => environment.getVertexLocation());
  ipcMain.handle(desktopSettingsChannels.setVertexLocation, (_event, value: unknown) =>
    environment.saveVertexLocation(typeof value === "string" ? value : "")
  );
  ipcMain.handle(desktopSettingsChannels.getVertexApiKey, () => environment.getVertexApiKey());
  ipcMain.handle(desktopSettingsChannels.setVertexApiKey, (_event, key: unknown) =>
    environment.saveVertexApiKey(typeof key === "string" ? key : "")
  );

  ipcMain.handle(desktopSettingsChannels.saveAllKeysToEnv, () =>
    environment.saveAllKeysToEnvFile()
  );

  // ---- hotkeys ---------------------------------------------------------------------

  ipcMain.handle(
    desktopSettingsChannels.setHotkeyListeningMode,
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        return { success: false };
      }
      if (hotkeyCaptureMode === enabled) return { success: true, skipped: true };
      hotkeyCaptureMode = enabled;
      windowManager.setHotkeyListeningMode(enabled);
      // Slots registered through IPC announce their changes so macOS can
      // re-derive which keys the native Globe listener owns.
      ipcMain.emit?.("hotkey-listening-mode-changed", null, enabled);

      if (enabled) {
        // Entering capture mode — unregister ALL slots so none intercept keypresses.
        // Dictation is always active; meeting and agent may or may not be set.
        const allSlots = hotkeyManager.slots;
        for (const [slot, info] of allSlots) {
          // Native-listener entries (null accelerator) are handled by the
          // platform hotkey manager.
          for (const accel of info?.accelerators || []) {
            if (!accel) continue;
            logger.log(
              `[IPC] Unregistering globalShortcut "${accel}" (slot "${slot}") for capture mode`
            );
            try {
              globalShortcut.unregister(accel);
            } catch {}
          }
        }
      } else {
        // Exiting capture mode — re-register globalShortcut-backed hotkeys.
        for (const [slot, info] of hotkeyManager.slots) {
          const hotkeys = info?.hotkeys || [];
          if (hotkeys.length === 0 || !info?.callback) continue;
          logger.log(
            `[IPC] Re-registering slot "${slot}" ("${hotkeys.join(", ")}") after capture mode`
          );
          await hotkeyManager.registerSlot(slot, hotkeys, info.callback).catch((err: Error) => {
            logger.warn(`[IPC] Failed to re-register slot "${slot}":`, err.message);
          });
        }
      }

      return { success: true };
    }
  );

  ipcMain.handle(desktopSettingsChannels.getHotkeyModeInfo, (_event, requestedHotkey: unknown) => {
    const hotkey =
      typeof requestedHotkey === "string" && requestedHotkey.trim()
        ? requestedHotkey.split(",")[0].trim()
        : hotkeyManager.getCurrentHotkey();
    const isUsingNativeShortcut = windowManager.isUsingNativeShortcutHotkeys();
    const supportsPushToTalk = hotkeyManager.supportsPushToTalk(hotkey);

    return {
      isUsingGnome: false,
      isUsingHyprland: false,
      isUsingKDE: false,
      isUsingNativeShortcut,
      supportsPushToTalk,
      pushToTalkUnavailableReason: supportsPushToTalk
        ? null
        : hotkeyManager.getPushToTalkUnavailableReason(hotkey),
    };
  });

  ipcMain.handle(desktopSettingsChannels.registerCancelHotkey, (_event, key: unknown) => {
    return hotkeyManager.registerSlot("cancel", key, () => {
      deps.sendToMainWindow("cancel-hotkey-pressed");
    });
  });

  ipcMain.handle(desktopSettingsChannels.unregisterCancelHotkey, () => {
    hotkeyManager.unregisterSlot("cancel");
    return { success: true };
  });

  ipcMain.handle(desktopSettingsChannels.getEffectiveDefaultHotkey, () => {
    return hotkeyManager?.getEffectiveDefaultHotkey() ?? null;
  });

  ipcMain.handle(desktopSettingsChannels.startControlPanelDrag, () =>
    windowManager.startControlPanelDrag()
  );
  ipcMain.handle(desktopSettingsChannels.stopControlPanelDrag, () =>
    windowManager.stopControlPanelDrag()
  );

  // ---- external links ----------------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.openExternal, async (_event, url: unknown) => {
    try {
      const parsedUrl = zUrlString.safeParse(url);
      if (!parsedUrl.success) {
        return { success: false, error: "Invalid URL" };
      }
      const { protocol } = new URL(parsedUrl.data);
      if (!["http:", "https:", "mailto:"].includes(protocol)) {
        return { success: false, error: `Blocked URL scheme: ${protocol}` };
      }
      await openExternalUrl(parsedUrl.data);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ---- startup / activation mode --------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.getAutoStartEnabled, async () => {
    try {
      return getAutoStartState();
    } catch (error) {
      logger.error("Error getting auto-start status:", error);
      return { enabled: false, requiresApproval: false };
    }
  });

  ipcMain.handle(desktopSettingsChannels.setAutoStartEnabled, async (_event, enabled: unknown) => {
    try {
      setAutoStartEnabled(enabled === true);
      logger.debug("Auto-start setting updated", { enabled });
      return { success: true };
    } catch (error) {
      logger.error("Error setting auto-start:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(desktopSettingsChannels.getActivationMode, () => environment.getActivationMode());

  ipcMain.handle(desktopSettingsChannels.saveActivationMode, (_event, mode: unknown) => {
    const parsed = activationModeSchema.safeParse(mode);
    if (!parsed.success) {
      return { success: false };
    }
    return environment.saveActivationMode(parsed.data);
  });

  ipcMain.handle(desktopSettingsChannels.syncStartupPreferences, (_event, prefs: unknown) => {
    const parsed = startupPreferencesSchema.safeParse(prefs);
    if (!parsed.success) {
      return;
    }
    const p = parsed.data;
    const setVars: Record<string, string> = {};
    const clearVars: string[] = [];

    if (p.useLocalWhisper && p.model) {
      // Local mode with model selected - set provider and model for pre-warming
      setVars.LOCAL_TRANSCRIPTION_PROVIDER = p.localTranscriptionProvider ?? "";
      if (p.language) setVars.DICTATION_LANGUAGE = p.language;
      if (isSherpaLocalProvider(p.localTranscriptionProvider)) {
        setVars.PARAKEET_MODEL = p.model;
        clearVars.push("LOCAL_WHISPER_MODEL");
        deps.stopWhisperServer().catch((err: Error) => {
          logger.error("Failed to stop whisper-server on provider switch", {
            error: err.message,
          });
        });
      } else {
        setVars.LOCAL_WHISPER_MODEL = p.model;
        clearVars.push("PARAKEET_MODEL");
        deps.stopParakeetServer().catch((err: Error) => {
          logger.error("Failed to stop parakeet-server on provider switch", {
            error: err.message,
          });
        });
      }
    } else if (p.useLocalWhisper) {
      // Local mode enabled but no model selected - clear pre-warming vars
      clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
    } else {
      // Direct mode - stop local servers when unused
      clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
      deps.stopWhisperServer().catch((err: Error) => {
        logger.error("Failed to stop whisper-server after direct-mode switch", {
          error: err.message,
        });
      });
      deps.stopParakeetServer().catch((err: Error) => {
        logger.error("Failed to stop parakeet-server on cloud switch", {
          error: err.message,
        });
      });
    }

    const localServer = resolveLocalServerNeeds({
      useCleanupModel: p.useCleanupModel === true,
      cleanupMode: p.cleanupMode,
      cleanupModel: p.cleanupModel,
    });

    if (localServer.cleanup) {
      setVars.CLEANUP_PROVIDER = "local";
      setVars.LOCAL_CLEANUP_MODEL = localServer.cleanup;
    } else {
      clearVars.push("CLEANUP_PROVIDER", "LOCAL_CLEANUP_MODEL");
    }
    // TODO: drop legacy REASONING_PROVIDER / LOCAL_REASONING_MODEL clears once
    // the read fallback is removed (~2 releases after this lands).
    clearVars.push("REASONING_PROVIDER", "LOCAL_REASONING_MODEL");

    // Stop the shared llama-server only when neither scope still needs it, so
    // the active scope keeps its server when the other one switches away.
    if (localServer.stopServer) {
      deps.stopLlamaServer().catch((err: Error) => {
        logger.error("Failed to stop llama-server on provider switch", {
          error: err.message,
        });
      });
    }

    syncStartupEnv(deps, setVars, clearVars);
  });

  // ---- language ---------------------------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.getUiLanguage, () => environment.getUiLanguage());

  ipcMain.handle(desktopSettingsChannels.saveUiLanguage, (_event, language: unknown) => {
    if (typeof language !== "string") {
      return { success: false, language: environment.getUiLanguage() };
    }
    return environment.saveUiLanguage(language);
  });

  ipcMain.handle(desktopSettingsChannels.setUiLanguage, (_event, language: unknown) => {
    if (typeof language !== "string") {
      return { success: false, language: environment.getUiLanguage() };
    }
    const result = environment.saveUiLanguage(language);
    process.env.UI_LANGUAGE = result.language;
    changeLanguage(result.language);
    windowManager.refreshLocalizedUi?.();
    deps.getTrayManager()?.updateTrayMenu?.();
    return { success: true, language: result.language };
  });

  // ---- logging / debug ----------------------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.getLogLevel, () => debugLogger.getLevel());

  ipcMain.handle(desktopSettingsChannels.log, (_event, entry: unknown) => {
    debugLogger.logEntry(entry);
    return { success: true };
  });

  ipcMain.handle(desktopSettingsChannels.getDebugState, async () => {
    try {
      return {
        enabled: debugLogger.isEnabled(),
        logPath: debugLogger.getLogPath(),
        logLevel: debugLogger.getLevel(),
      };
    } catch (error) {
      logger.error("Failed to get debug state:", error);
      return { enabled: false, logPath: null, logLevel: "info" };
    }
  });

  ipcMain.handle(desktopSettingsChannels.setDebugLogging, async (_event, enabled: unknown) => {
    try {
      if (typeof enabled !== "boolean") {
        return { success: false, error: "Invalid debug logging request" };
      }
      const envPath = path.join(app.getPath("userData"), ".env");

      // Read current .env content
      let envContent = "";
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, "utf8");
      }

      // Parse lines
      const lines = envContent.split("\n");
      const logLevelIndex = lines.findIndex((line) =>
        line.trim().startsWith("OPENHERCULES_LOG_LEVEL=")
      );

      if (enabled) {
        // Set to debug
        if (logLevelIndex !== -1) {
          lines[logLevelIndex] = "OPENHERCULES_LOG_LEVEL=debug";
        } else {
          // Add new line
          if (lines.length > 0 && lines[lines.length - 1] !== "") {
            lines.push("");
          }
          lines.push("# Debug logging setting");
          lines.push("OPENHERCULES_LOG_LEVEL=debug");
        }
      } else {
        // Remove or set to info
        if (logLevelIndex !== -1) {
          lines[logLevelIndex] = "OPENHERCULES_LOG_LEVEL=info";
        }
      }

      // Write back
      fs.writeFileSync(envPath, lines.join("\n"), "utf8");

      // Update environment variable
      process.env.OPENHERCULES_LOG_LEVEL = enabled ? "debug" : "info";

      // Refresh logger state
      debugLogger.refreshLogLevel();

      return {
        success: true,
        enabled: debugLogger.isEnabled(),
        logPath: debugLogger.getLogPath(),
      };
    } catch (error) {
      logger.error("Failed to set debug logging:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(desktopSettingsChannels.openLogsFolder, async () => {
    try {
      const logsDir = path.join(app.getPath("userData"), "logs");
      const errMsg = await shellOpenPath(logsDir);
      if (errMsg) return { success: false, error: errMsg };
      return { success: true };
    } catch (error) {
      logger.error("Failed to open logs folder:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  // ---- permissions / system settings ----------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.openMicrophoneSettings, () =>
    openSystemSettings("microphone")
  );
  ipcMain.handle(desktopSettingsChannels.openSoundInputSettings, () =>
    openSystemSettings("sound")
  );
  ipcMain.handle(desktopSettingsChannels.getSystemDefaultMicrophone, (_event, options: unknown) =>
    resolveSystemDefaultMicrophone({
      refresh: (options as { refresh?: boolean } | undefined)?.refresh === true,
    })
  );
  ipcMain.handle(desktopSettingsChannels.openAccessibilitySettings, () =>
    openSystemSettings("accessibility")
  );
  ipcMain.handle(desktopSettingsChannels.openSystemAudioSettings, () =>
    openSystemSettings("systemAudio")
  );
  ipcMain.handle(desktopSettingsChannels.openScreenRecordingSettings, () =>
    openSystemSettings("screenRecording")
  );
  ipcMain.handle(desktopSettingsChannels.openLoginItemsSettings, () =>
    openSystemSettings("loginItems")
  );

  ipcMain.handle(desktopSettingsChannels.showEmojiPanel, () => {
    try {
      if (app.isEmojiPanelSupported()) {
        app.showEmojiPanel();
        return true;
      }
    } catch (error) {
      logger.error("Failed to show native emoji panel:", error);
    }
    return false;
  });

  ipcMain.handle(desktopSettingsChannels.requestMicrophoneAccess, async () => {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    return { granted };
  });

  ipcMain.handle(desktopSettingsChannels.checkMicrophoneAccess, () => {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    return { granted: status === "granted", status };
  });

  const getSystemAudioAccess = () => {
    if (!deps.audioTap.isSupported()) {
      return buildSystemAudioAccess();
    }
    const result = deps.audioTap.checkAccess();
    return buildSystemAudioAccess({
      granted: result.granted,
      status: result.status,
      native: true,
    });
  };

  ipcMain.handle(desktopSettingsChannels.checkSystemAudioAccess, () => getSystemAudioAccess());

  ipcMain.handle(desktopSettingsChannels.requestSystemAudioAccess, async () => {
    if (!deps.audioTap.isSupported()) {
      return buildSystemAudioAccess();
    }

    try {
      const result = await deps.audioTap.requestAccess();
      if (result.granted) {
        return buildSystemAudioAccess({
          granted: true,
          status: "granted",
          native: true,
        });
      }
    } catch {
      // Falls through to opening System Settings
    }

    await openSystemSettings("systemAudio");
    const status = deps.audioTap.getPermissionStatus();
    return buildSystemAudioAccess({
      granted: false,
      status,
      native: true,
    });
  });

  ipcMain.handle(desktopSettingsChannels.checkAccessibilityPermission, async () => {
    return systemPreferences.isTrustedAccessibilityClient(false);
  });

  // Passes `true` to isTrustedAccessibilityClient to trigger the macOS system prompt
  ipcMain.handle(desktopSettingsChannels.promptAccessibilityPermission, async () => {
    return systemPreferences.isTrustedAccessibilityClient(true);
  });

  // ---- clipboard -------------------------------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.readClipboard, () => {
    return clipboard.readText();
  });

  ipcMain.handle(desktopSettingsChannels.writeClipboard, (_event, text: unknown) => {
    if (typeof text !== "string") throw new TypeError("Clipboard text must be a string");
    clipboard.writeText(text);
    return { success: true };
  });

  // ---- notification preferences ------------------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.syncNotificationPreferences, (_event, prefs: unknown) => {
    try {
      const parsed = notificationPreferencesSchema.safeParse(prefs);
      if (!parsed.success) {
        return { success: false, error: "Invalid preferences" };
      }
      for (const [k, v] of Object.entries(parsed.data)) {
        if (NOTIFICATION_PREF_KEYS.has(k)) {
          windowManager.notificationPrefs[k] = v;
        }
      }
      // Detection only serves the notification, so the toggle also gates the detector.
      const { notificationsEnabled, notifyMeetingDetection } = windowManager.notificationPrefs;
      deps.setDetectionGateForNotifications(
        Boolean(notificationsEnabled && notifyMeetingDetection)
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ---- device cleanup ------------------------------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.cleanupApp, async (event) => {
    const errors: string[] = [];
    const mainWindow = windowManager.mainWindow;
    const cleanup = deps.cleanup;

    // Stop services before deleting files they hold open
    try {
      await cleanup.stopParakeetServer();
    } catch (e) {
      errors.push(`Parakeet stop: ${(e as Error).message}`);
    }
    try {
      cleanup.stopWhisperServer();
    } catch (e) {
      errors.push(`Whisper stop: ${(e as Error).message}`);
    }
    try {
      cleanup.stopGoogleCalendar();
    } catch (e) {
      errors.push(`GCal stop: ${(e as Error).message}`);
    }
    try {
      cleanup.stopMicrosoftCalendar();
    } catch (e) {
      errors.push(`MCal stop: ${(e as Error).message}`);
    }
    try {
      cleanup.stopAppleCalendar();
    } catch (e) {
      errors.push(`ACal stop: ${(e as Error).message}`);
    }
    try {
      await cleanup.shutdownDiarization();
    } catch (e) {
      errors.push(`Diarization stop: ${(e as Error).message}`);
    }
    // Revoke Google OAuth tokens before DB is closed
    try {
      await cleanup.revokeGoogleTokens();
    } catch (e) {
      errors.push(`GCal revoke: ${(e as Error).message}`);
    }

    // Close DB connection before deleting the file
    try {
      cleanup.closeDatabase();
    } catch (e) {
      errors.push(`DB close: ${(e as Error).message}`);
    }

    // Delete audio files
    try {
      cleanup.deleteAllAudio();
    } catch (e) {
      errors.push(`Audio delete: ${(e as Error).message}`);
    }

    // Delete downloaded models
    try {
      cleanup.deleteWhisperModels();
    } catch (e) {
      errors.push(`Whisper models: ${(e as Error).message}`);
    }
    try {
      await cleanup.deleteParakeetModels();
    } catch (e) {
      errors.push(`Parakeet models: ${(e as Error).message}`);
    }
    try {
      await cleanup.deleteDiarizationModels();
    } catch (e) {
      errors.push(`Diarization models: ${(e as Error).message}`);
    }
    try {
      await cleanup.deleteLlmModels();
    } catch (e) {
      errors.push(`LLM models: ${(e as Error).message}`);
    }

    // These caches are not owned by one account. Remove them only through
    // the explicit device-erasure path, never during normal account deletion.
    const homeCacheRoot = path.join(os.homedir(), ".cache", "openhercules");
    for (const cacheName of []) {
      try {
        fs.rmSync(path.join(homeCacheRoot, cacheName), { recursive: true, force: true });
      } catch (e) {
        errors.push(`${cacheName} cache: ${(e as Error).message}`);
      }
    }

    // Delete database file + WAL/SHM
    try {
      const dbPath = path.join(
        app.getPath("userData"),
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
      );
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
      if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
    } catch (e) {
      errors.push(`DB file: ${(e as Error).message}`);
    }

    // Delete device-wide settings and encrypted credentials.
    try {
      await environment.clearAllPersistedData();
    } catch (e) {
      errors.push(`Environment settings: ${(e as Error).message}`);
    }
    try {
      for (const fileName of ["globe-preference-state.json", ".system-audio-permission"]) {
        fs.rmSync(path.join(app.getPath("userData"), fileName), { force: true });
      }
    } catch (e) {
      errors.push(`Device setting files: ${(e as Error).message}`);
    }
    for (const directoryName of ["bin", "llama-cpp"]) {
      try {
        fs.rmSync(path.join(app.getPath("userData"), directoryName), {
          recursive: true,
          force: true,
        });
      } catch (e) {
        errors.push(`${directoryName} runtime: ${(e as Error).message}`);
      }
    }
    try {
      setAutoStartEnabled(false);
    } catch (e) {
      errors.push(`Launch at login: ${(e as Error).message}`);
    }

    // Clear browser-held account/session state, including cookies, IndexedDB,
    // Cache Storage and localStorage persisted by any app window.
    try {
      const win = BrowserWindow.fromWebContents((event as { sender: WebContents }).sender);
      if (win) {
        await win.webContents.session.clearStorageData();
        await win.webContents.session.clearCache();
      }
    } catch (e) {
      errors.push(`Browser data: ${(e as Error).message}`);
    }

    // Clear localStorage
    if (mainWindow?.webContents) {
      try {
        await mainWindow.webContents.executeJavaScript("localStorage.clear()");
      } catch (e) {
        errors.push(`localStorage: ${(e as Error).message}`);
      }
    }

    if (errors.length > 0) {
      logger.warn("Cleanup completed with errors", { errors }, "cleanup");
    }

    return { success: errors.length === 0, message: "Cleanup completed", errors };
  });

  // ---- app metadata / model folders -----------------------------------------------------------------

  ipcMain.handle(desktopSettingsChannels.getOAuthProtocolRegistered, () => {
    return deps.oauthProtocolRegistered;
  });

  ipcMain.handle(desktopSettingsChannels.getOAuthProtocol, () => deps.oauthProtocol);

  ipcMain.handle(desktopSettingsChannels.getAppVersion, () => ({ version: app.getVersion() }));

  ipcMain.handle(desktopSettingsChannels.getModelCacheRoot, () => getCacheRoot());

  ipcMain.handle(desktopSettingsChannels.openWhisperModelsFolder, async () => {
    try {
      const cacheRoot = getCacheRoot();
      await fs.promises.mkdir(cacheRoot, { recursive: true });
      const errMsg = await shellOpenPath(cacheRoot);
      if (errMsg) return { success: false, error: errMsg };
      return { success: true };
    } catch (error) {
      logger.error("Failed to open model cache folder:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(desktopSettingsChannels.getMD5Hash, (_event, text: unknown) => {
    if (typeof text !== "string") {
      return "";
    }
    return crypto.createHash("md5").update(text.toLowerCase().trim()).digest("hex");
  });
}

const zUrlString = z.string();
const buildSystemAudioAccess = (
  partial: { granted?: boolean; status?: string; native?: boolean } = {}
) => ({
  granted: partial.granted ?? false,
  status: partial.status ?? "unsupported",
  mode: partial.native ? "native" : "unsupported",
  supportsPersistentGrant: false,
  supportsPersistentPortalGrant: false,
  supportsNativeCapture: false,
  supportsOnboardingGrant: false,
  requiresRuntimeSharePrompt: false,
  strategy: partial.native ? "native" : "unsupported",
  restoreTokenAvailable: false,
  portalVersion: null,
});

function shellOpenPath(p: string): Promise<string | null> {
  return shell.openPath(p);
}
