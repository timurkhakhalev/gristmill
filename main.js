const { createHotkeyRepeatGate } = require("./src/helpers/hotkeyRepeatGate");

const {
  app,
  globalShortcut,
  BrowserWindow,
  dialog,
  ipcMain,
} = require("electron");
const path = require("path");
const tls = require("tls");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Extend Node's TLS trust with the OS store so ws and https.get see corporate
// CAs that Chromium already trusts.
try {
  const currentCAs = tls.getCACertificates();
  const systemCAs = tls.getCACertificates("system");
  if (systemCAs?.length) {
    tls.setDefaultCACertificates([...currentCAs, ...systemCAs]);
  }
} catch (err) {
  require("./src/helpers/debugLogger").warn("System CA merge failed; using existing CA list", {
    error: err?.message,
  });
}

const VALID_CHANNELS = new Set(["development", "staging", "production"]);
const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = {
  development: "openhercules-dev",
  staging: "openhercules-staging",
  production: "openhercules",
};
const APP_NAME = "OpenHercules";

function isElectronBinaryExec() {
  const execPath = (process.execPath || "").toLowerCase();
  return (
    execPath.includes("/electron.app/contents/macos/electron") ||
    execPath.endsWith("/electron") ||
    execPath.endsWith("\\electron.exe")
  );
}

function inferDefaultChannel() {
  if (process.env.NODE_ENV === "development" || process.defaultApp || isElectronBinaryExec()) {
    return "development";
  }
  return "production";
}

function resolveAppChannel() {
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

function configureChannelUserDataPath() {
  const profileName = APP_CHANNEL === "production" ? APP_NAME : `${APP_NAME}-${APP_CHANNEL}`;
  const explicitPath = app.commandLine.getSwitchValue("user-data-dir");
  const isolatedPath = explicitPath
    ? path.resolve(explicitPath)
    : path.join(app.getPath("appData"), profileName);
  app.setPath("userData", isolatedPath);
}

configureChannelUserDataPath();

// Load userData .env (contains DICTATION_KEY, API keys, etc.) early — before
// hotkey registration, which needs DICTATION_KEY before the renderer loads.
require("dotenv").config({
  path: path.join(app.getPath("userData"), ".env"),
  override: false,
});


function getOAuthProtocol() {
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

function shouldRegisterProtocolWithAppArg() {
  return Boolean(process.defaultApp) || isElectronBinaryExec();
}

// Register custom protocol for OAuth callbacks.
function registerOpenHerculesProtocol() {
  const protocol = OAUTH_PROTOCOL;

  let result;
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

const isLiveWindow = (window) => window && !window.isDestroyed();

// Ensure macOS menus use the proper casing for the app name
if (process.platform === "darwin" && app.getName() !== APP_NAME) {
  app.setName(APP_NAME);
}

// Add global error handling for uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Don't exit the process for EPIPE errors as they're harmless
  if (error.code === "EPIPE") {
    return;
  }
  // For other errors, log and continue
  console.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Import helper module classes (but don't instantiate yet - wait for app.whenReady())
const EnvironmentManager = require("./src/helpers/environment");
const WindowManager = require("./src/helpers/windowManager");
const DatabaseManager = require("./src/helpers/database");
const WhisperManager = require("./src/helpers/whisper");
const ParakeetManager = require("./src/helpers/parakeet");
const DiarizationManager = require("./src/helpers/diarization");
const TrayManager = require("./src/helpers/tray");
const dockManager = require("./src/helpers/dockManager");
const autoStart = require("./src/helpers/autoStart");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const CliBridge = require("./src/helpers/cliBridge");
const GlobeKeyManager = require("./src/helpers/globeKeyManager");
const GoogleCalendarManager = require("./src/helpers/googleCalendarManager");
const MicrosoftCalendarManager = require("./src/helpers/microsoftCalendarManager");
const AppleCalendarManager = require("./src/helpers/appleCalendarManager");
const CalendarReminderScheduler = require("./src/helpers/calendarReminderScheduler");
const MeetingProcessDetector = require("./src/helpers/meetingProcessDetector");
const AudioActivityDetector = require("./src/helpers/audioActivityDetector");
const {
  collectAudioCaptureHelperPids,
  createExcludedProcessIdProvider,
} = require("./src/helpers/electronProcessIds");
const AudioTapManager = require("./src/helpers/audioTapManager");
const MeetingAecManager = require("./src/helpers/meetingAecManager");
const MeetingDetectionEngine = require("./src/helpers/meetingDetectionEngine");
const { i18nMain, changeLanguage } = require("./src/helpers/i18nMain");
const sidecarRegistry = require("./src/helpers/sidecarRegistry");
const { reapStaleSidecars } = require("./src/helpers/sidecarReaper");

// Manager instances - initialized after app.whenReady()
let debugLogger = null;
let environmentManager = null;
let windowManager = null;
let hotkeyManager = null;
let databaseManager = null;
let whisperManager = null;
let parakeetManager = null;
let diarizationManager = null;
let trayManager = null;
let globeKeyManager = null;
let googleCalendarManager = null;
let microsoftCalendarManager = null;
let appleCalendarManager = null;
let calendarReminderScheduler = null;
let meetingDetectionEngine = null;
let audioTapManager = null;
let meetingAecManager = null;
let ipcHandlers = null;
let cliBridge = null;
let globeKeyAlertShown = false;
const WHISPER_WAKE_REWARM_DELAY_MS = 3000;
let wakeRewarmTimer = null;

// Set up PATH for production builds to find system tools (whisper.cpp, ffmpeg)
function setupProductionPath() {
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
function wasLaunchedAtLoginHidden() {
  try {
    return autoStart.wasLaunchedAtLoginHidden();
  } catch (error) {
    if (debugLogger) debugLogger.warn("Failed to detect a login launch", { error: error?.message });
    return false;
  }
}

function initializeCoreManagers() {
  setupProductionPath();

  debugLogger = require("./src/helpers/debugLogger");
  debugLogger.ensureFileLogging();

  environmentManager = new EnvironmentManager();
  const uiLanguage = environmentManager.getUiLanguage(app.getLocale());
  changeLanguage(uiLanguage);
  debugLogger.refreshLogLevel();

  windowManager = new WindowManager();
  hotkeyManager = windowManager.hotkeyManager;
  databaseManager = new DatabaseManager();
  whisperManager = new WhisperManager();
  parakeetManager = new ParakeetManager();
  diarizationManager = new DiarizationManager();
  calendarReminderScheduler = new CalendarReminderScheduler(databaseManager);
  googleCalendarManager = new GoogleCalendarManager(
    databaseManager,
    windowManager,
    calendarReminderScheduler
  );
  microsoftCalendarManager = new MicrosoftCalendarManager(
    databaseManager,
    calendarReminderScheduler
  );
  appleCalendarManager = new AppleCalendarManager(databaseManager, calendarReminderScheduler);
  const meetingProcessDetector = new MeetingProcessDetector();
  meetingDetectionEngine = new MeetingDetectionEngine(
    calendarReminderScheduler,
    meetingProcessDetector,
    new AudioActivityDetector(
      // The capture-helper managers are created a few lines below; the provider
      // is only invoked on mic events, long after initialization completes.
      createExcludedProcessIdProvider(() =>
        collectAudioCaptureHelperPids([
          audioTapManager,
        ])
      ),
      () => meetingProcessDetector.getDetectedProcesses().length > 0
    ),
    windowManager,
    databaseManager
  );
  windowManager.meetingDetectionEngine = meetingDetectionEngine;
  calendarReminderScheduler.meetingDetectionEngine = meetingDetectionEngine;
  audioTapManager = new AudioTapManager();
  meetingAecManager = new MeetingAecManager();

  // IPC handlers must be registered before window content loads
  ipcHandlers = new IPCHandlers({
    environmentManager,
    databaseManager,
    whisperManager,
    parakeetManager,
    diarizationManager,
    windowManager,
    googleCalendarManager,
    microsoftCalendarManager,
    appleCalendarManager,
    meetingDetectionEngine,
    audioTapManager,
    meetingAecManager,
    getTrayManager: () => trayManager,
    oauthProtocolRegistered: protocolRegistered,
    oauthProtocol: OAUTH_PROTOCOL,
  });
}

function registerSidecars() {
  if (whisperManager) sidecarRegistry.register("whisper", () => whisperManager.stopServer());
  if (parakeetManager) sidecarRegistry.register("parakeet", () => parakeetManager.stopServer());
  if (diarizationManager) {
    sidecarRegistry.register("diarization", () => diarizationManager.shutdown());
  }
  const modelManager = require("./src/helpers/modelManagerBridge").default;
  sidecarRegistry.register("llama", () => modelManager.stopServer());
  const onnxWorkerClient = require("./src/helpers/onnxWorkerClient");
  sidecarRegistry.register("onnx", () => onnxWorkerClient.stop());
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers() {
  trayManager = new TrayManager();
  globeKeyManager = new GlobeKeyManager({
    // Lets the listener put the user's macOS Globe action back after a crash.
    preferenceStatePath: path.join(app.getPath("userData"), "globe-preference-state.json"),
  });

  if (process.platform === "darwin") {
    globeKeyManager.on("error", (error) => {
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

  googleCalendarManager.start();
  microsoftCalendarManager.start();
  appleCalendarManager.start();
  meetingDetectionEngine.start();
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
async function startApp() {
  // Await so a stale sidecar is confirmed dead before new ones can spawn and
  // contend for its port or storage lock.
  await reapStaleSidecars();

  // Phase 1: Core managers + IPC handlers before windows
  initializeCoreManagers();
  await environmentManager.init();
  registerSidecars();

  cliBridge = new CliBridge(ipcHandlers);
  cliBridge.start().catch((err) => {
    debugLogger.error("CLI bridge failed to start", { error: err.message });
    cliBridge = null;
  });


  ipcMain.on("start-minimized-changed", (_event, enabled) => {
    if (debugLogger) debugLogger.info("Start minimized changed", { enabled });
    environmentManager.saveStartMinimized(enabled);
  });


  dockManager.init();

  // In development, wait for Vite dev server to be ready
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Create windows FIRST so the user sees UI as soon as possible.
  // A login launch goes to the tray whatever the preference says: the user asked
  // the OS to start us, not to put a window in front of them at every login.
  const launchedHidden = wasLaunchedAtLoginHidden();
  const startMinimized = environmentManager.getStartMinimized() || launchedHidden;
  if (debugLogger) debugLogger.info("Start minimized", { enabled: startMinimized, launchedHidden });
  if (!startMinimized) {
    await windowManager.createControlPanelWindow();
  }

  // Set up meeting mode hotkey
  const isMeetingPress = createHotkeyRepeatGate();
  const meetingHotkeyCallback = () => {
    if (!isMeetingPress()) return;
    if (hotkeyManager.isInListeningMode()) return;
    // Fail closed during onboarding, like every other hotkey slot.
    if (!windowManager.isMeetingInputAllowed()) return;
    debugLogger.info("Meeting hotkey triggered", {}, "meeting");
    meetingDetectionEngine?.startManualMeeting();
  };

  const savedMeetingKey = environmentManager.getMeetingKey?.() || "";
  if (savedMeetingKey) {
    const result = await hotkeyManager.registerSlot(
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

  ipcMain.handle("register-meeting-hotkey", async (_event, hotkey) => {
    if (hotkey) {
      const result = await hotkeyManager.registerSlot("meeting", hotkey, meetingHotkeyCallback, {
        atomic: true,
      });
      if (result.success) {
        environmentManager.saveMeetingKey(hotkey);
        return { success: true };
      }
      return { success: false, message: result.error };
    } else {
      hotkeyManager.unregisterSlot("meeting");
      environmentManager.saveMeetingKey("");
      return { success: true };
    }
  });

  // Phase 2: Initialize remaining managers after windows are visible
  initializeDeferredManagers();
  if (process.platform === "darwin") {
    // Restore a Globe preference marker left by a crash without starting any
    // Accessibility-protected event monitors during onboarding.
    await globeKeyManager.restoreLeftoverSystemPreference();
  }

  app.on("browser-window-focus", () => {
    if (googleCalendarManager) googleCalendarManager.syncOnFocus();
    if (microsoftCalendarManager) microsoftCalendarManager.syncOnFocus();
    if (appleCalendarManager) appleCalendarManager.syncOnFocus();
  });

  const { powerMonitor } = require("electron");
  powerMonitor.on("resume", () => {
    if (calendarReminderScheduler) calendarReminderScheduler.onWakeFromSleep();
    if (googleCalendarManager) {
      googleCalendarManager.onWakeFromSleep();
    }
    if (microsoftCalendarManager) microsoftCalendarManager.onWakeFromSleep();
    if (appleCalendarManager) appleCalendarManager.onWakeFromSleep();
    // Sleep evicts the local GPU model from VRAM; reload it once the driver settles. See #766.
    if (wakeRewarmTimer) clearTimeout(wakeRewarmTimer);
    wakeRewarmTimer = setTimeout(() => {
      wakeRewarmTimer = null;
      whisperManager?.onWakeFromSleep().catch((err) => {
        debugLogger.debug("whisper wake re-warm error (non-fatal)", { error: err.message });
      });
    }, WHISPER_WAKE_REWARM_DELAY_MS);
  });

  // Non-blocking server pre-warming; GPU backend resolved by the manager
  const whisperSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    whisperModel: process.env.LOCAL_WHISPER_MODEL,
  };
  whisperManager.initializeAtStartup(whisperSettings).catch((err) => {
    debugLogger.debug("Whisper startup init error (non-fatal)", { error: err.message });
  });

  const parakeetSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    parakeetModel: process.env.PARAKEET_MODEL,
    language: process.env.DICTATION_LANGUAGE,
  };
  parakeetManager.initializeAtStartup(parakeetSettings).catch((err) => {
    debugLogger.debug("Parakeet startup init error (non-fatal)", { error: err.message });
  });

  const cleanupProvider = process.env.CLEANUP_PROVIDER;
  const cleanupLocalModel = process.env.LOCAL_CLEANUP_MODEL;
  if (cleanupProvider === "local" && cleanupLocalModel) {
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    modelManager.prewarmServer(cleanupLocalModel).catch((err) => {
      debugLogger.debug("llama-server pre-warm error (non-fatal)", { error: err.message });
    });
  }

  // Auto-download diarization models if binary is available
  if (
    diarizationManager.getBinaryPath() &&
    (!diarizationManager.isModelDownloaded() || !diarizationManager.isVadModelDownloaded())
  ) {
    diarizationManager.downloadModels().catch((err) => {
      debugLogger.debug("Diarization model auto-download error (non-fatal)", {
        error: err.message,
      });
    });
  }

  trayManager.setWindows(windowManager.controlPanelWindow);
  trayManager.setWindowManager(windowManager);
  trayManager.setCreateControlPanelCallback(() => windowManager.createControlPanelWindow());
  await trayManager.createTray();


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
      startApp().catch((error) => {
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
    sidecarRegistry.shutdownAll().finally(() => app.exit(0));
  });
}

function performSyncTeardown() {
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
