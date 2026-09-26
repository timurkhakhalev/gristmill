import { app, globalShortcut, BrowserWindow, dialog, ipcMain, powerMonitor } from "electron";
import fs from "fs";
import path from "path";
import tls from "tls";
import { createHotkeyRepeatGate } from "./src/helpers/hotkeyRepeatGate.js";
import debugLogger from "./src/helpers/debugLogger.js";
import type { EnvironmentManagerWithByok } from "./src/helpers/environment.js";
import { EnvironmentManager } from "./src/helpers/environment.js";
import { WindowManager } from "./src/helpers/windowManager.js";
import { DatabaseManager } from "./src/helpers/database.js";
import { WhisperManager } from "./src/helpers/whisper.js";
import { ParakeetManager } from "./src/helpers/parakeet.js";
import { DiarizationManager } from "./src/helpers/diarization.js";
import { TrayManager } from "./src/helpers/tray.js";
import dockManager from "./src/helpers/dockManager.js";
import { wasLaunchedAtLoginHidden } from "./src/helpers/autoStart.js";
import { IPCHandlers } from "./src/helpers/ipcHandlers.js";
import { CliBridge } from "./src/helpers/cliBridge.js";
import { GlobeKeyManager } from "./src/helpers/globeKeyManager.js";
import { GoogleCalendarManager } from "./src/helpers/googleCalendarManager.js";
import { MicrosoftCalendarManager } from "./src/helpers/microsoftCalendarManager.js";
import { AppleCalendarManager } from "./src/helpers/appleCalendarManager.js";
import { CalendarReminderScheduler } from "./src/helpers/calendarReminderScheduler.js";
import { MeetingProcessDetector } from "./src/helpers/meetingProcessDetector.js";
import { AudioActivityDetector } from "./src/helpers/audioActivityDetector.js";
import {
  collectAudioCaptureHelperPids,
  createExcludedProcessIdProvider,
} from "./src/helpers/electronProcessIds.js";
import { registerMeetingHotkeyHandler } from "./src/helpers/meetingHotkeyIpcHandler.js";
import { AudioTapManager } from "./src/helpers/audioTapManager.js";
import { MeetingAecManager } from "./src/helpers/meetingAecManager.js";
import { MeetingDetectionEngine } from "./src/helpers/meetingDetectionEngine.js";
import { i18nMain, changeLanguage } from "./src/helpers/i18nMain.js";
import { register as registerSidecar, shutdownAll } from "./src/helpers/sidecarRegistry.js";
import { reapStaleSidecars } from "./src/helpers/sidecarReaper.js";
import type { ModelManager } from "./src/helpers/modelManagerBridge.js";

require("dotenv").config({ path: path.join(app.getAppPath(), ".env") });

// Electron exposes `defaultApp` on its process object when the app runs from
// the electron binary; Node's process types don't declare it.
const electronProcess = process as NodeJS.Process & { defaultApp?: boolean };

// Extend Node's TLS trust with the OS store so ws and https.get see corporate
// CAs that Chromium already trusts.
try {
  const currentCAs = tls.getCACertificates();
  const systemCAs = tls.getCACertificates("system");
  if (systemCAs?.length) {
    tls.setDefaultCACertificates([...currentCAs, ...systemCAs]);
  }
} catch (err) {
  debugLogger.warn("System CA merge failed; using existing CA list", {
    error: (err as Error | null | undefined)?.message,
  });
}

const VALID_CHANNELS = new Set(["development", "staging", "production"]);
const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL: Record<string, string> = {
  development: "openhercules-dev",
  staging: "openhercules-staging",
  production: "openhercules",
};
const APP_NAME = "OpenHercules";

function isElectronBinaryExec(): boolean {
  const execPath = (process.execPath || "").toLowerCase();
  return (
    execPath.includes("/electron.app/contents/macos/electron") ||
    execPath.endsWith("/electron") ||
    execPath.endsWith("\\electron.exe")
  );
}

function inferDefaultChannel(): string {
  if (
    process.env.NODE_ENV === "development" ||
    electronProcess.defaultApp ||
    isElectronBinaryExec()
  ) {
    return "development";
  }
  return "production";
}

function resolveAppChannel(): string {
  if (app.isPackaged) {
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")
      ) as { openherculesChannel?: string };
      if (metadata.openherculesChannel === "development") return "development";
    } catch (error) {
      debugLogger.warn("Could not read packaged app channel", {
        error: (error as Error).message,
      });
    }
  }

  const rawChannel = (process.env.OPENHERCULES_CHANNEL || process.env.VITE_OPENHERCULES_CHANNEL || "")
    .trim()
    .toLowerCase();

  if (VALID_CHANNELS.has(rawChannel)) {
    return rawChannel;
  }

  return inferDefaultChannel();
}

const APP_CHANNEL = resolveAppChannel();
process.env.OPENHERCULES_CHANNEL = APP_CHANNEL;

function configureChannelUserDataPath(): void {
  const profileName = APP_CHANNEL === "production" ? APP_NAME : `${APP_NAME}-${APP_CHANNEL}`;
  const explicitPath = app.commandLine.getSwitchValue("user-data-dir");
  const isolatedPath = explicitPath
    ? path.resolve(explicitPath)
    : path.join(app.getPath("appData"), profileName);
  app.setPath("userData", isolatedPath);
}

configureChannelUserDataPath();

// Early profile .env pass: startup selectors below (OAuth protocol, the dev
// snapshot refresh flag) read keys that may live in the profile .env. Values
// are not overridden — the post-snapshot pass below adds the rest (copied
// credentials) without clobbering anything set here.
require("dotenv").config({
  path: path.join(app.getPath("userData"), ".env"),
  override: false,
});


function getOAuthProtocol(): string {
  const fromEnv = (process.env.VITE_OPENHERCULES_PROTOCOL || process.env.OPENHERCULES_PROTOCOL || "")
    .trim()
    .toLowerCase();

  if (/^[a-z][a-z0-9+.-]*$/.test(fromEnv)) {
    return fromEnv;
  }

  return (
    DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL[APP_CHANNEL] || DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL.production
  );
}

const OAUTH_PROTOCOL = getOAuthProtocol();

function shouldRegisterProtocolWithAppArg(): boolean {
  return Boolean(electronProcess.defaultApp) || isElectronBinaryExec();
}

// Register custom protocol for OAuth callbacks.
function registerOpenHerculesProtocol(): boolean {
  const protocol = OAUTH_PROTOCOL;

  let result: boolean;
  if (shouldRegisterProtocolWithAppArg()) {
    const appArg = process.argv[1] ? path.resolve(process.argv[1]) : path.resolve(".");
    result = app.setAsDefaultProtocolClient(protocol, process.execPath, [appArg]);
  } else {
    result = app.setAsDefaultProtocolClient(protocol);
  }

  return result;
}

const protocolRegistered = registerOpenHerculesProtocol();
if (!protocolRegistered) {
  console.warn(`[Auth] Failed to register ${OAUTH_PROTOCOL}:// protocol handler`);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

// Dev channel: seed the isolated dev profile from a one-way snapshot of the
// production profile (issue #86) before anything reads userData. Explicit
// --user-data-dir smoke/debug profiles stay isolated and receive no
// production data. Both run AFTER the single-instance lock so two concurrent
// dev launches cannot race the snapshot; failures refuse to start (the app
// would otherwise create an empty dev database and mask the failure forever).
if (APP_CHANNEL === "development" && gotSingleInstanceLock) {
  const devSnapshot = require("./src/helpers/devSnapshot.js");
  // The alias refusal applies to every development launch, including explicit
  // --user-data-dir: a dev build must never write inside the production
  // profile through any path spelling.
  let devOk = !devSnapshot.devProfileAliasesProduction();
  if (devOk && !app.commandLine.getSwitchValue("user-data-dir")) {
    devOk = devSnapshot.snapshotProductionProfileForDev();
  }
  if (!devOk) {
    console.error("[devSnapshot] dev profile check failed; exiting. The next launch retries.");
    app.exit(1);
  }
}

// Second profile .env pass after the dev snapshot: a first dev launch gets
// the copied credentials without a restart. override:false keeps anything the
// early pass or the system environment already set.
require("dotenv").config({
  path: path.join(app.getPath("userData"), ".env"),
  override: false,
});

function isLiveWindow(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed());
}

// Keep the packaged development app visibly distinct in macOS menus.
const displayName = app.isPackaged && APP_CHANNEL === "development" ? "OpenHercules Dev" : APP_NAME;
if (process.platform === "darwin" && app.getName() !== displayName) {
  app.setName(displayName);
}

// Add global error handling for uncaught exceptions
process.on("uncaughtException", (error: Error) => {
  console.error("Uncaught Exception:", error);
  // Don't exit the process for EPIPE errors as they're harmless
  if ((error as NodeJS.ErrnoException).code === "EPIPE") {
    return;
  }
  // For other errors, log and continue
  console.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Manager instances - initialized after app.whenReady()
let environmentManager: EnvironmentManagerWithByok | null = null;
let windowManager: WindowManager | null = null;
let hotkeyManager: WindowManager["hotkeyManager"] | null = null;
let databaseManager: DatabaseManager | null = null;
let whisperManager: WhisperManager | null = null;
let parakeetManager: ParakeetManager | null = null;
let diarizationManager: DiarizationManager | null = null;
let trayManager: TrayManager | null = null;
let globeKeyManager: GlobeKeyManager | null = null;
let googleCalendarManager: GoogleCalendarManager | null = null;
let microsoftCalendarManager: MicrosoftCalendarManager | null = null;
let appleCalendarManager: AppleCalendarManager | null = null;
let calendarReminderScheduler: CalendarReminderScheduler | null = null;
let meetingDetectionEngine: MeetingDetectionEngine | null = null;
let audioTapManager: AudioTapManager | null = null;
let meetingAecManager: MeetingAecManager | null = null;
let ipcHandlers: IPCHandlers | null = null;
let cliBridge: CliBridge | null = null;
let globeKeyAlertShown = false;
const WHISPER_WAKE_REWARM_DELAY_MS = 3000;
let wakeRewarmTimer: NodeJS.Timeout | null = null;

// The lazily required singleton bridge: the module keeps its pre-cutover
// module.exports shape ({ default: instance, ... }) so the require sites in
// startup paths stay lazy.
type ModelManagerBridgeModule = { default: ModelManager };

function requireModelManager(): ModelManager {
  return (require("./src/helpers/modelManagerBridge") as ModelManagerBridgeModule).default;
}

// Set up PATH for production builds to find system tools (whisper.cpp, ffmpeg)
function setupProductionPath(): void {
  if (process.platform === "darwin" && process.env.NODE_ENV !== "development") {
    const commonPaths = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];

    const currentPath = process.env.PATH || "";
    const pathsToAdd = commonPaths.filter((p) => !currentPath.includes(p));

    if (pathsToAdd.length > 0) {
      process.env.PATH = `${currentPath}:${pathsToAdd.join(":")}`;
    }
  }
}

// Reading the login item touches the OS, and failing to answer "did the session
// start us?" must not stop the app from starting at all. Falling back to false
// just shows the window, which is what every launch did before.
function wasLaunchedAtLoginHiddenSafe(): boolean {
  try {
    return wasLaunchedAtLoginHidden();
  } catch (error) {
    debugLogger.warn(
      "Failed to detect a login launch",
      { error: (error as Error | null | undefined)?.message }
    );
    return false;
  }
}

function initializeCoreManagers(): void {
  setupProductionPath();

  debugLogger.ensureFileLogging();

  // The BYOK accessors are generated onto the prototype from the key catalog
  // at module load; the intersection type makes that surface visible.
  const initializedEnvironmentManager = new EnvironmentManager() as EnvironmentManagerWithByok;
  environmentManager = initializedEnvironmentManager;
  const uiLanguage = initializedEnvironmentManager.getUiLanguage(app.getLocale());
  changeLanguage(uiLanguage);
  debugLogger.refreshLogLevel();

  const initializedWindowManager = new WindowManager();
  windowManager = initializedWindowManager;
  hotkeyManager = initializedWindowManager.hotkeyManager;
  const initializedDatabaseManager = new DatabaseManager();
  databaseManager = initializedDatabaseManager;
  const initializedWhisperManager = new WhisperManager();
  whisperManager = initializedWhisperManager;
  const initializedParakeetManager = new ParakeetManager();
  parakeetManager = initializedParakeetManager;
  const initializedDiarizationManager = new DiarizationManager();
  diarizationManager = initializedDiarizationManager;
  const initializedCalendarReminderScheduler = new CalendarReminderScheduler(
    initializedDatabaseManager
  );
  calendarReminderScheduler = initializedCalendarReminderScheduler;
  const initializedGoogleCalendarManager = new GoogleCalendarManager(
    initializedDatabaseManager,
    initializedWindowManager,
    initializedCalendarReminderScheduler
  );
  googleCalendarManager = initializedGoogleCalendarManager;
  const initializedMicrosoftCalendarManager = new MicrosoftCalendarManager(
    initializedDatabaseManager,
    initializedCalendarReminderScheduler
  );
  microsoftCalendarManager = initializedMicrosoftCalendarManager;
  const initializedAppleCalendarManager = new AppleCalendarManager(
    initializedDatabaseManager,
    initializedCalendarReminderScheduler
  );
  appleCalendarManager = initializedAppleCalendarManager;
  const initializedMeetingProcessDetector = new MeetingProcessDetector();
  const initializedMeetingDetectionEngine = new MeetingDetectionEngine(
    initializedCalendarReminderScheduler,
    initializedMeetingProcessDetector,
    new AudioActivityDetector(
      // The capture-helper managers are created a few lines below; the provider
      // is only invoked on mic events, long after initialization completes.
      createExcludedProcessIdProvider(() =>
        collectAudioCaptureHelperPids([
          audioTapManager,
        ])
      ),
      () => initializedMeetingProcessDetector.getDetectedProcesses().length > 0
    ),
    initializedWindowManager,
    initializedDatabaseManager
  );
  meetingDetectionEngine = initializedMeetingDetectionEngine;
  initializedWindowManager.meetingDetectionEngine = initializedMeetingDetectionEngine;
  initializedCalendarReminderScheduler.meetingDetectionEngine =
    initializedMeetingDetectionEngine;
  const initializedAudioTapManager = new AudioTapManager();
  audioTapManager = initializedAudioTapManager;
  const initializedMeetingAecManager = new MeetingAecManager();
  meetingAecManager = initializedMeetingAecManager;

  // IPC handlers must be registered before window content loads
  ipcHandlers = new IPCHandlers({
    environmentManager: initializedEnvironmentManager,
    databaseManager: initializedDatabaseManager,
    whisperManager: initializedWhisperManager,
    parakeetManager: initializedParakeetManager,
    diarizationManager: initializedDiarizationManager,
    windowManager: initializedWindowManager,
    googleCalendarManager: initializedGoogleCalendarManager,
    microsoftCalendarManager: initializedMicrosoftCalendarManager,
    appleCalendarManager: initializedAppleCalendarManager,
    meetingDetectionEngine: initializedMeetingDetectionEngine,
    audioTapManager: initializedAudioTapManager,
    meetingAecManager: initializedMeetingAecManager,
    getTrayManager: () => trayManager,
    oauthProtocolRegistered: protocolRegistered,
    oauthProtocol: OAUTH_PROTOCOL,
  });
}

function registerSidecars(): void {
  if (whisperManager) {
    const manager = whisperManager;
    registerSidecar("whisper", () => manager.stopServer());
  }
  if (parakeetManager) {
    const manager = parakeetManager;
    registerSidecar("parakeet", () => manager.stopServer());
  }
  if (diarizationManager) {
    const manager = diarizationManager;
    registerSidecar("diarization", () => manager.shutdown());
  }
  const modelManager = requireModelManager();
  registerSidecar("llama", () => modelManager.stopServer());
  const onnxWorkerClient = require("./src/helpers/onnxWorkerClient") as {
    stop(): Promise<void>;
  };
  registerSidecar("onnx", () => onnxWorkerClient.stop());
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers(): void {
  trayManager = new TrayManager();
  globeKeyManager = new GlobeKeyManager({
    // Lets the listener put the user's macOS Globe action back after a crash.
    preferenceStatePath: path.join(app.getPath("userData"), "globe-preference-state.json"),
  });

  if (process.platform === "darwin") {
    globeKeyManager.on("error", (error: Error | null | undefined) => {
      if (globeKeyAlertShown) {
        return;
      }
      globeKeyAlertShown = true;

      const detailLines = [
        error?.message || i18nMain.t("startup.globeHotkey.details.unknown"),
        i18nMain.t("startup.globeHotkey.details.fallback"),
      ];

      if (process.env.NODE_ENV === "development") {
        detailLines.push(i18nMain.t("startup.globeHotkey.details.devHint"));
      } else {
        detailLines.push(i18nMain.t("startup.globeHotkey.details.reinstallHint"));
      }

      dialog.showMessageBox({
        type: "warning",
        title: i18nMain.t("startup.globeHotkey.title"),
        message: i18nMain.t("startup.globeHotkey.message"),
        detail: detailLines.join("\n\n"),
      });
    });
  }

  googleCalendarManager?.start();
  microsoftCalendarManager?.start();
  appleCalendarManager?.start();
  meetingDetectionEngine?.start();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!url.startsWith(`${OAUTH_PROTOCOL}://`)) return;

  if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
    windowManager.controlPanelWindow.show();
    windowManager.controlPanelWindow.focus();
    dockManager.setControlPanelVisible(true);
  }
});

// Main application startup
async function startApp(): Promise<void> {
  dockManager.init();
  // Await so a stale sidecar is confirmed dead before new ones can spawn and
  // contend for its port or storage lock.
  await reapStaleSidecars();

  // Phase 1: Core managers + IPC handlers before windows
  initializeCoreManagers();
  const initializedEnvironmentManager = environmentManager as EnvironmentManager;
  const initializedWindowManager = windowManager as WindowManager;
  const initializedHandlers = ipcHandlers as IPCHandlers;
  await initializedEnvironmentManager.init();
  registerSidecars();

  const initializedCliBridge = new CliBridge({
    databaseManager: initializedHandlers.databaseManager,
    deleteNoteInternal: (id) => initializedHandlers.deleteNoteInternal(id),
    deleteTranscriptionInternal: (id) => initializedHandlers.deleteTranscriptionInternal(id),
    mirrorWriteNote: (note) => initializedHandlers._asyncMirrorWrite(note),
    approveAudioPath: (filePath) => initializedHandlers.approveAudioPath(filePath),
    transcribeLocalFile: (filePath, options) =>
      initializedHandlers.transcribeLocalFile(filePath, options),
    listLocalTranscriptionModels: () => initializedHandlers.listLocalTranscriptionModels(),
    audioStorageManager: initializedHandlers.audioStorageManager,
  });
  cliBridge = initializedCliBridge;
  initializedCliBridge.start().catch((err: Error) => {
    debugLogger.error("CLI bridge failed to start", { error: err.message });
    cliBridge = null;
  });


  ipcMain.on("start-minimized-changed", (_event, enabled: boolean) => {
    debugLogger.info("Start minimized changed", { enabled });
    initializedEnvironmentManager.saveStartMinimized(enabled);
  });


  // In development, wait for Vite dev server to be ready
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Create windows FIRST so the user sees UI as soon as possible.
  // A login launch goes to the tray whatever the preference says: the user asked
  // the OS to start us, not to put a window in front of them at every login.
  const launchedHidden = wasLaunchedAtLoginHiddenSafe();
  const startMinimized = initializedEnvironmentManager.getStartMinimized() || launchedHidden;
  debugLogger.info("Start minimized", { enabled: startMinimized, launchedHidden });
  if (!startMinimized) {
    await initializedWindowManager.createControlPanelWindow();
  }

  // Set up meeting mode hotkey
  const isMeetingPress = createHotkeyRepeatGate();
  const meetingHotkeyCallback = () => {
    if (!isMeetingPress()) return;
    if (!hotkeyManager || hotkeyManager.isInListeningMode()) return;
    // Fail closed during onboarding, like every other hotkey slot.
    if (!initializedWindowManager.isMeetingInputAllowed()) return;
    debugLogger.info("Meeting hotkey triggered", {}, "meeting");
    void meetingDetectionEngine?.startManualMeeting();
  };

  // The re-registration handler (settings UI path) lives in the typed owner;
  // the bootstrap slot registration below and the shared callback stay here,
  // along with the menu/tray/window wiring and the onboarding gate.
  registerMeetingHotkeyHandler({
    ipcMain,
    hotkeyManager: hotkeyManager as NonNullable<typeof hotkeyManager>,
    environmentManager: initializedEnvironmentManager,
    meetingHotkeyCallback,
  });

  const savedMeetingKey = initializedEnvironmentManager.getMeetingKey() || "";
  if (savedMeetingKey) {
    const result = await (hotkeyManager as NonNullable<typeof hotkeyManager>).registerSlot(
      "meeting",
      savedMeetingKey,
      meetingHotkeyCallback
    );
    debugLogger.info(
      "Meeting hotkey startup registration",
      { savedMeetingKey, ...result },
      "meeting"
    );
  }

  // Phase 2: Initialize remaining managers after windows are visible
  initializeDeferredManagers();
  if (process.platform === "darwin") {
    // Restore a Globe preference marker left by a crash without starting any
    // Accessibility-protected event monitors during onboarding.
    await (globeKeyManager as GlobeKeyManager).restoreLeftoverSystemPreference();
  }

  app.on("browser-window-focus", () => {
    googleCalendarManager?.syncOnFocus();
    microsoftCalendarManager?.syncOnFocus();
    appleCalendarManager?.syncOnFocus();
  });

  powerMonitor.on("resume", () => {
    calendarReminderScheduler?.onWakeFromSleep();
    googleCalendarManager?.onWakeFromSleep();
    microsoftCalendarManager?.onWakeFromSleep();
    appleCalendarManager?.onWakeFromSleep();
    // Sleep evicts the local GPU model from VRAM; reload it once the driver settles. See #766.
    if (wakeRewarmTimer) clearTimeout(wakeRewarmTimer);
    wakeRewarmTimer = setTimeout(() => {
      wakeRewarmTimer = null;
      whisperManager
        ?.onWakeFromSleep()
        .catch((err: Error) => {
          debugLogger.debug("whisper wake re-warm error (non-fatal)", { error: err.message });
        });
    }, WHISPER_WAKE_REWARM_DELAY_MS);
  });

  // Non-blocking server pre-warming; GPU backend resolved by the manager
  const whisperSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    whisperModel: process.env.LOCAL_WHISPER_MODEL,
  };
  (whisperManager as WhisperManager)
    .initializeAtStartup(whisperSettings)
    .catch((err: Error) => {
      debugLogger.debug("Whisper startup init error (non-fatal)", { error: err.message });
    });

  const parakeetSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    parakeetModel: process.env.PARAKEET_MODEL,
    language: process.env.DICTATION_LANGUAGE,
  };
  (parakeetManager as ParakeetManager)
    .initializeAtStartup(parakeetSettings)
    .catch((err: Error) => {
      debugLogger.debug("Parakeet startup init error (non-fatal)", { error: err.message });
    });

  const cleanupProvider = process.env.CLEANUP_PROVIDER;
  const cleanupLocalModel = process.env.LOCAL_CLEANUP_MODEL;
  if (cleanupProvider === "local" && cleanupLocalModel) {
    const modelManager = requireModelManager();
    modelManager.prewarmServer(cleanupLocalModel).catch((err: Error) => {
      debugLogger.debug("llama-server pre-warm error (non-fatal)", { error: err.message });
    });
  }

  // Auto-download diarization models if binary is available
  const initializedDiarizationManager = diarizationManager as DiarizationManager;
  if (
    initializedDiarizationManager.getBinaryPath() &&
    (!initializedDiarizationManager.isModelDownloaded() ||
      !initializedDiarizationManager.isVadModelDownloaded())
  ) {
    initializedDiarizationManager.downloadModels().catch((err: Error) => {
      debugLogger.debug("Diarization model auto-download error (non-fatal)", {
        error: err.message,
      });
    });
  }

  const initializedTrayManager = trayManager as TrayManager;
  initializedTrayManager.setWindows(initializedWindowManager.controlPanelWindow);
  initializedTrayManager.setWindowManager(initializedWindowManager);
  initializedTrayManager.setCreateControlPanelCallback(() =>
    initializedWindowManager.createControlPanelWindow()
  );
  await initializedTrayManager.createTray();


}

// App event handlers
if (gotSingleInstanceLock) {
  app.on("second-instance", async (_event, _commandLine) => {
    await app.whenReady();
    if (!windowManager) {
      return;
    }

    if (isLiveWindow(windowManager.controlPanelWindow)) {
      if (windowManager.controlPanelWindow.isMinimized()) {
        windowManager.controlPanelWindow.restore();
      }
      windowManager.controlPanelWindow.show();
      windowManager.controlPanelWindow.focus();
      dockManager.setControlPanelVisible(true);
      if (windowManager.controlPanelWindow.webContents.isCrashed()) {
        windowManager.loadControlPanel();
      }
    } else {
      windowManager.createControlPanelWindow();
    }


  });

  app
    .whenReady()
    .then(() => {
      return Promise.resolve();
    })
    .then(() => {
      startApp().catch((error: Error) => {
        console.error("Failed to start app:", error);
        dialog.showErrorBox(
          i18nMain.t("startup.error.title"),
          i18nMain.t("startup.error.message", { error: error.message })
        );
        app.exit(1);
      });
    });

  app.on("window-all-closed", () => {
    // macOS keeps the app available in the dock and menu bar.
  });


  app.on("activate", () => {
    // On macOS, re-create windows when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      if (windowManager) {
        windowManager.createControlPanelWindow();
      }
    } else {
      // Show control panel when dock icon is clicked (most common user action)
      if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
        if (windowManager.controlPanelWindow.isMinimized()) {
          windowManager.controlPanelWindow.restore();
        }
        windowManager.controlPanelWindow.show();
        windowManager.controlPanelWindow.focus();
        dockManager.setControlPanelVisible(true);
      } else if (windowManager) {
        // If control panel doesn't exist, create it
        windowManager.createControlPanelWindow();
      }

    }
  });

  let isShuttingDown = false;
  app.on("before-quit", (event) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    event.preventDefault();
    performSyncTeardown();
    shutdownAll().finally(() => app.exit(0));
  });
}

function performSyncTeardown(): void {
  if (wakeRewarmTimer) {
    clearTimeout(wakeRewarmTimer);
    wakeRewarmTimer = null;
  }
  if (cliBridge) {
    cliBridge.stop().catch(() => {});
    cliBridge = null;
  }
  if (hotkeyManager) {
    hotkeyManager.unregisterAll();
  } else {
    globalShortcut.unregisterAll();
  }
  if (globeKeyManager) globeKeyManager.stop();
  if (meetingDetectionEngine) meetingDetectionEngine.stop();
  if (googleCalendarManager) googleCalendarManager.stop();
  if (microsoftCalendarManager) microsoftCalendarManager.stop();
  if (appleCalendarManager) appleCalendarManager.stop();
  if (calendarReminderScheduler) calendarReminderScheduler.stop();
  if (audioTapManager) audioTapManager.stop().catch(() => {});
  if (meetingAecManager) meetingAecManager.stop().catch(() => {});
}
