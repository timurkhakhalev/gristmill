// Chromium picks the display backend before JS runs, so appendSwitch is too
// late — the flag has to come from a relaunch.
const { XWAYLAND_FLAG, shouldForceXWayland } = require("./src/helpers/xwayland");
const { createHotkeyRepeatGate } = require("./src/helpers/hotkeyRepeatGate");

if (shouldForceXWayland(process.argv)) {
  const { spawn } = require("child_process");
  spawn(process.execPath, [...process.argv.slice(1), XWAYLAND_FLAG], {
    stdio: "inherit",
    detached: true,
  }).unref();
  process.exit(0);
}

const {
  app,
  desktopCapturer,
  globalShortcut,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
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
const BASE_WINDOWS_APP_ID = "com.openhercules.desktop";

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
  const isolatedPath = path.join(app.getPath("appData"), profileName);
  app.setPath("userData", isolatedPath);
}

configureChannelUserDataPath();

// Load userData .env (contains DICTATION_KEY, API keys, etc.) early — before
// hotkey registration, which needs DICTATION_KEY before the renderer loads.
require("dotenv").config({
  path: path.join(app.getPath("userData"), ".env"),
  override: false,
});

// Chromium's Windows-only occlusion tracker misclassifies the always-on-top
// transparent pill as occluded, throttling its renderer and jittering animations.
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

// Fix transparent window flickering on Linux: --enable-transparent-visuals requires
// the compositor to set up an ARGB visual before any windows are created.
// --disable-gpu-compositing prevents GPU compositing conflicts with the compositor.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("gtk-version", "3");
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// Wayland: packaged builds use the wrapper script (scripts/afterPack.js) to
// force --ozone-platform=x11 before Electron starts. appendSwitch below is a
// best-effort fallback for unpackaged dev mode (may not take effect on E39+).
if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
  app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
}

// Set desktop filename so Wayland compositors can match windows to the .desktop entry.
// This allows XDG portals (e.g. PipeWire) to persist permissions across sessions.
if (process.platform === "linux") {
  app.setDesktopName("openhercules.desktop");
}

// Group all windows under single taskbar entry on Windows
if (process.platform === "win32") {
  const windowsAppId =
    APP_CHANNEL === "production" ? BASE_WINDOWS_APP_ID : `${BASE_WINDOWS_APP_ID}.${APP_CHANNEL}`;
  app.setAppUserModelId(windowsAppId);
}

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

function getDefaultHtmlHandler() {
  try {
    const { execFileSync } = require("child_process");
    return (
      execFileSync("xdg-mime", ["query", "default", "text/html"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function restoreHtmlHandlerIfChanged(original) {
  try {
    const { execFileSync } = require("child_process");
    const current = execFileSync("xdg-mime", ["query", "default", "text/html"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (current && current !== original) {
      execFileSync("xdg-mime", ["default", original, "text/html"], { timeout: 3000 });
    }
  } catch {
    // xdg-mime unavailable or failed
  }
}

// True source of truth for whether the OpenHercules protocol resolves on Linux — the same
// MIME database xdg-open consults. Returns true for deb/rpm/flatpak/AUR installs
// (scheme registered via the packaged .desktop MimeType) and false for AppImage/
// tar.gz runs where it genuinely isn't registered, so we never enable a dead-end
// OAuth flow. Used to recover from setAsDefaultProtocolClient's KDE false negative.
function isOAuthSchemeRegistered() {
  if (process.platform !== "linux") return false;
  try {
    const { execFileSync } = require("child_process");
    const handler = execFileSync(
      "xdg-mime",
      ["query", "default", `x-scheme-handler/${OAUTH_PROTOCOL}`],
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    return handler.length > 0;
  } catch {
    return false;
  }
}

// Register custom protocol for OAuth callbacks.
// In development, always include the app path argument so macOS/Windows/Linux
// can launch the project app instead of opening bare Electron.
function registerOpenHerculesProtocol() {
  const protocol = OAUTH_PROTOCOL;
  const htmlHandler = process.platform === "linux" ? getDefaultHtmlHandler() : null;

  let result;
  if (shouldRegisterProtocolWithAppArg()) {
    const appArg = process.argv[1] ? path.resolve(process.argv[1]) : path.resolve(".");
    result = app.setAsDefaultProtocolClient(protocol, process.execPath, [appArg]);
  } else {
    result = app.setAsDefaultProtocolClient(protocol);
  }

  if (htmlHandler) {
    restoreHtmlHandlerIfChanged(htmlHandler);
  }

  return result;
}

// setAsDefaultProtocolClient returns a false negative on KDE/Wayland, so on Linux
// fall back to probing the system MIME database for an actual handler. This keeps
// OAuth enabled where the callback can resolve (deb/rpm/flatpak/AUR) and correctly
// gated where it can't (AppImage/tar.gz with no scheme registration).
const protocolRegistered = registerOpenHerculesProtocol() || isOAuthSchemeRegistered();
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
const ClipboardManager = require("./src/helpers/clipboard");
const WhisperManager = require("./src/helpers/whisper");
const ParakeetManager = require("./src/helpers/parakeet");
const DiarizationManager = require("./src/helpers/diarization");
const TrayManager = require("./src/helpers/tray");
const dockManager = require("./src/helpers/dockManager");
const autoStart = require("./src/helpers/autoStart");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const CliBridge = require("./src/helpers/cliBridge");
const GlobeKeyManager = require("./src/helpers/globeKeyManager");
const WindowsKeyManager = require("./src/helpers/windowsKeyManager");
const LinuxKeyManager = require("./src/helpers/linuxKeyManager");
const TextEditMonitor = require("./src/helpers/textEditMonitor");
const SelectionManager = require("./src/helpers/selectionManager");
const WhisperCudaManager = require("./src/helpers/whisperCudaManager");
const WhisperVulkanManager = require("./src/helpers/whisperVulkanManager");
const { migrateLegacyBinDir, detectOrphanedGpuPacks } = require("./src/helpers/gpuBinaryManager");
const { resetWhisperGpuFailureOnUpgrade } = require("./src/helpers/whisperGpuUpgradeReset");
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
const LinuxPortalAudioManager = require("./src/helpers/linuxPortalAudioManager");
const WindowsLoopbackAudioManager = require("./src/helpers/windowsLoopbackAudioManager");
const MeetingAecManager = require("./src/helpers/meetingAecManager");
const MeetingDetectionEngine = require("./src/helpers/meetingDetectionEngine");
const { i18nMain, changeLanguage } = require("./src/helpers/i18nMain");
const { ensureYdotool } = require("./src/helpers/ensureYdotool");
const sidecarRegistry = require("./src/helpers/sidecarRegistry");
const { reapStaleSidecars } = require("./src/helpers/sidecarReaper");

// Manager instances - initialized after app.whenReady()
let debugLogger = null;
let environmentManager = null;
let windowManager = null;
let hotkeyManager = null;
let databaseManager = null;
let clipboardManager = null;
let whisperManager = null;
let parakeetManager = null;
let diarizationManager = null;
let trayManager = null;
let globeKeyManager = null;
let windowsKeyManager = null;
let linuxKeyManager = null;
let textEditMonitor = null;
let selectionManager = null;
let whisperCudaManager = null;
let whisperVulkanManager = null;
let googleCalendarManager = null;
let microsoftCalendarManager = null;
let appleCalendarManager = null;
let calendarReminderScheduler = null;
let meetingDetectionEngine = null;
let audioTapManager = null;
let linuxPortalAudioManager = null;
let windowsLoopbackAudioManager = null;
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

// Phase 1: Initialize managers + IPC handlers before window content loads
// Best-effort cleanup of the orphaned portal restore-token file older builds wrote. See PR #904.
const LINUX_RESTORE_TOKEN_FILENAME = ".linux-system-audio-restore-token.json";

function cleanupOrphanedLinuxRestoreToken() {
  if (process.platform !== "linux") return;
  try {
    const fs = require("fs");
    fs.unlinkSync(path.join(app.getPath("userData"), LINUX_RESTORE_TOKEN_FILENAME));
  } catch {}
}

function syncAutoStartEntry() {
  try {
    if (autoStart.syncAutoStartEntry()) {
      debugLogger.info("Re-pointed the launch-at-login entry at the current executable");
    }
  } catch (error) {
    debugLogger.warn("Failed to sync the launch-at-login entry", { error: error?.message });
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
  clipboardManager = new ClipboardManager();
  whisperManager = new WhisperManager();
  if (process.platform !== "darwin") {
    whisperCudaManager = new WhisperCudaManager();
    whisperVulkanManager = new WhisperVulkanManager();
    // Heal installs from before GPU packs got per-pack directories; must run
    // before startup pre-warm resolves any GPU binary path.
    const LlamaVulkanManager = require("./src/helpers/llamaVulkanManager");
    const llamaVulkanManager = new LlamaVulkanManager();
    const clearedPacks = migrateLegacyBinDir([
      whisperCudaManager,
      whisperVulkanManager,
      llamaVulkanManager,
    ]);
    if (clearedPacks.length > 0) {
      // No window exists yet — persist the notice; a control panel window
      // shows it as a toast and clears it. See #1606.
      require("./src/helpers/gpuPackMigrationNotice").record(clearedPacks);
    }
    // The 1.8.3 migration deleted lib-carrying packs without recording that
    // notice, leaving those users on a silent CPU fallback: an enabled flag
    // with no pack on disk only happens via such data loss. recordOnce gates
    // each pack to one notice so a dismissed toast doesn't return every launch.
    const orphanedPacks = detectOrphanedGpuPacks([
      { manager: whisperCudaManager, enabledEnvVar: "WHISPER_CUDA_ENABLED" },
      { manager: whisperVulkanManager, enabledEnvVar: "WHISPER_VULKAN_ENABLED" },
      { manager: llamaVulkanManager, enabledEnvVar: "LLAMA_VULKAN_ENABLED" },
    ]);
    if (orphanedPacks.length > 0) {
      require("./src/helpers/gpuPackMigrationNotice").recordOnce(orphanedPacks);
    }
    // Lets every server start resolve its GPU backend from installed packs
    whisperManager.setGpuBinaryManagers({ cuda: whisperCudaManager, vulkan: whisperVulkanManager });
  }
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
          linuxPortalAudioManager,
          windowsLoopbackAudioManager,
        ])
      ),
      () => meetingProcessDetector.getDetectedProcesses().length > 0
    ),
    windowManager,
    databaseManager
  );
  windowManager.meetingDetectionEngine = meetingDetectionEngine;
  calendarReminderScheduler.meetingDetectionEngine = meetingDetectionEngine;
  windowsKeyManager = new WindowsKeyManager();
  linuxKeyManager = new LinuxKeyManager();
  textEditMonitor = new TextEditMonitor();
  selectionManager = new SelectionManager({ clipboardManager, textEditMonitor });
  audioTapManager = new AudioTapManager();
  linuxPortalAudioManager = new LinuxPortalAudioManager();
  windowsLoopbackAudioManager = new WindowsLoopbackAudioManager();
  // Warm the capability cache off the hot path so the first meeting start
  // doesn't pay the probe spawn. No-ops on non-Windows.
  windowsLoopbackAudioManager.getCapability().catch(() => {});
  cleanupOrphanedLinuxRestoreToken();
  syncAutoStartEntry();
  meetingAecManager = new MeetingAecManager();
  windowManager.textEditMonitor = textEditMonitor;
  windowManager.selectionManager = selectionManager;
  windowManager.windowsKeyManager = windowsKeyManager;
  windowManager.linuxKeyManager = linuxKeyManager;

  // IPC handlers must be registered before window content loads
  ipcHandlers = new IPCHandlers({
    environmentManager,
    databaseManager,
    clipboardManager,
    whisperManager,
    parakeetManager,
    diarizationManager,
    windowManager,
    windowsKeyManager,
    linuxKeyManager,
    textEditMonitor,
    selectionManager,
    whisperCudaManager,
    whisperVulkanManager,
    googleCalendarManager,
    microsoftCalendarManager,
    appleCalendarManager,
    meetingDetectionEngine,
    audioTapManager,
    linuxPortalAudioManager,
    windowsLoopbackAudioManager,
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
  ensureYdotool().catch((err) => {
    require("./src/helpers/debugLogger").warn(
      "ydotool setup error",
      { error: err?.message },
      "clipboard"
    );
  });
  if (process.platform !== "darwin") {
    clipboardManager.preWarmAccessibility();
  }
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
  // After any upgrade the GPU gets one fresh attempt: clear the remembered
  // failure before the whisper pre-warm below resolves its GPU backend.
  resetWhisperGpuFailureOnUpgrade(environmentManager);
  registerSidecars();

  cliBridge = new CliBridge(ipcHandlers);
  cliBridge.start().catch((err) => {
    debugLogger.error("CLI bridge failed to start", { error: err.message });
    cliBridge = null;
  });


  await windowManager.setActivationModeCache(environmentManager.getActivationMode());
  windowManager.setFloatingIconAutoHide(environmentManager.getFloatingIconAutoHide());
  windowManager.setPanelStartPosition(environmentManager.getPanelStartPosition());

  let activationModeChangeQueue = Promise.resolve();
  ipcMain.on("activation-mode-changed", (_event, mode) => {
    activationModeChangeQueue = activationModeChangeQueue
      .then(async () => {
        const success = await windowManager.setActivationModeCache(mode);
        const effectiveMode = windowManager.getActivationMode();
        if (success) {
          environmentManager.saveActivationMode(effectiveMode);
        } else {
          for (const browserWindow of BrowserWindow.getAllWindows()) {
            if (!browserWindow.isDestroyed()) {
              browserWindow.webContents.send("setting-updated", {
                key: "activationMode",
                value: effectiveMode,
              });
            }
          }
        }
        windowManager.resetWindowsPushState();
        windowManager.reconcileNativeKeyListeners();
      })
      .catch((err) => {
        debugLogger.error("Failed to change activation mode", { error: err.message }, "hotkey");
      });
  });

  ipcMain.on("floating-icon-auto-hide-changed", (_event, enabled) => {
    windowManager.setFloatingIconAutoHide(enabled);
    environmentManager.saveFloatingIconAutoHide(enabled);
    // Relay to the floating icon window so it can react immediately
    if (windowManager.mainWindow && !windowManager.mainWindow.isDestroyed()) {
      windowManager.mainWindow.webContents.send("floating-icon-auto-hide-changed", enabled);
    }
  });

  ipcMain.on("start-minimized-changed", (_event, enabled) => {
    if (debugLogger) debugLogger.info("Start minimized changed", { enabled });
    environmentManager.saveStartMinimized(enabled);
  });

  ipcMain.on("panel-start-position-changed", (_event, position) => {
    windowManager.setPanelStartPosition(position);
    environmentManager.savePanelStartPosition(position);
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
  // The activation mode was cached before the hotkey was registered, so a saved
  // Hold could not be checked against its key until now.
  if (
    windowManager.getActivationMode() === "push" &&
    !windowManager.hotkeyManager.supportsPushToTalk()
  ) {
    await windowManager.setActivationModeCache("tap");
    environmentManager.saveActivationMode("tap");
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send("setting-updated", { key: "activationMode", value: "tap" });
      }
    }
  }
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
      windowManager.reconcileNativeKeyListeners();
      if (result.success) {
        environmentManager.saveMeetingKey(hotkey);
        return { success: true };
      }
      return { success: false, message: result.error };
    } else {
      hotkeyManager.unregisterSlot("meeting");
      environmentManager.saveMeetingKey("");
      windowManager.reconcileNativeKeyListeners();
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

  // TODO: drop legacy REASONING_PROVIDER / LOCAL_REASONING_MODEL fallbacks after 2 releases.
  const cleanupProvider = process.env.CLEANUP_PROVIDER || process.env.REASONING_PROVIDER;
  const cleanupLocalModel = process.env.LOCAL_CLEANUP_MODEL || process.env.LOCAL_REASONING_MODEL;
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

  if (process.platform === "win32") {
    const nircmdStatus = clipboardManager.getNircmdStatus();
    debugLogger.debug("Windows paste tool status", nircmdStatus);
  }

  trayManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  trayManager.setWindowManager(windowManager);
  trayManager.setCreateControlPanelCallback(() => windowManager.createControlPanelWindow());
  await trayManager.createTray();


  // Windows and Linux share the same native low-level key listener model: one hook
  // process per watched key (Electron globalShortcut can't see modifier-only or
  // right-side-modifier combos), routed to the owning slot here. macOS is handled
  // separately above via globeKeyManager.
  if (process.platform === "win32" || process.platform === "linux") {
    const isWindows = process.platform === "win32";
    const nativeKeyManager = isWindows ? windowsKeyManager : linuxKeyManager;
    const dispatchNativeKeyDown = (key) => {
      if (hotkeyManager.slotHasHotkey("meeting", key)) {
        if (!hotkeyManager.isInListeningMode() && windowManager.isMeetingInputAllowed()) {
          meetingDetectionEngine?.startManualMeeting();
        }
      }
    };

    debugLogger.debug("[Push-to-Talk] Native key listener setup starting");

    nativeKeyManager.on("key-down", dispatchNativeKeyDown);

    nativeKeyManager.on("error", (error) => {
      debugLogger.warn("[Push-to-Talk] Native key listener error", { error: error.message });
      if (isWindows && isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "error",
          message: error.message,
        });
      }
    });

    nativeKeyManager.on("unavailable", () => {
      debugLogger.debug(
        "[Push-to-Talk] Native key listener unavailable - falling back to toggle mode"
      );
      if (isWindows && isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "binary_not_found",
          message: i18nMain.t("windows.pttUnavailable"),
        });
      }
    });

    nativeKeyManager.on("ready", () => {
      debugLogger.debug("[Push-to-Talk] Native key listener ready and listening");
    });

    if (!isWindows) {
      nativeKeyManager.on("permission-denied", () => {
        debugLogger.warn(
          "[Push-to-Talk] Linux key listener has no permission to access input devices"
        );
        if (isLiveWindow(windowManager.mainWindow)) {
          windowManager.mainWindow.webContents.send("linux-ptt-permission-denied");
        }
      });
    }

    const STARTUP_DELAY_MS = 3000;
    setTimeout(() => windowManager.reconcileNativeKeyListeners(), STARTUP_DELAY_MS);

    ipcMain.on("hotkey-changed", () => {
      windowManager.resetWindowsPushState();
      windowManager.reconcileNativeKeyListeners();
    });
  }
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

    if (isLiveWindow(windowManager.mainWindow)) {
      windowManager.enforceMainWindowOnTop();
    } else {
      windowManager.createMainWindow();
    }

  });

  app
    .whenReady()
    .then(() => {
      // On Linux, --enable-transparent-visuals requires a short delay before creating
      // windows to allow the compositor to set up the ARGB visual correctly.
      // Without this delay, transparent windows flicker on both X11 and Wayland.
      const delay = process.platform === "linux" ? 300 : 0;
      return new Promise((resolve) => setTimeout(resolve, delay));
    })
    .then(() => {
      if (process.platform === "win32") {
        session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
          // Only the loopback audio track is used; the video source is
          // discarded by the renderer, so skip thumbnail generation.
          desktopCapturer
            .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
            .then((sources) => {
              if (sources.length > 0) {
                callback({ video: sources[0], audio: "loopback" });
              } else {
                callback(null);
              }
            })
            .catch((error) => {
              console.error("Display media request failed:", error);
              callback(null);
            });
        });
      }

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
    // Don't quit on macOS when all windows are closed
    // The app should stay in the dock/menu bar
    if (process.platform !== "darwin") {
      app.quit();
    }
    // On macOS, keep the app running even without windows
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
  if (windowsKeyManager) windowsKeyManager.stop();
  if (linuxKeyManager) linuxKeyManager.stop();
  if (meetingDetectionEngine) meetingDetectionEngine.stop();
  if (googleCalendarManager) googleCalendarManager.stop();
  if (microsoftCalendarManager) microsoftCalendarManager.stop();
  if (appleCalendarManager) appleCalendarManager.stop();
  if (calendarReminderScheduler) calendarReminderScheduler.stop();
  if (audioTapManager) audioTapManager.stop().catch(() => {});
  if (linuxPortalAudioManager) linuxPortalAudioManager.stop().catch(() => {});
  if (windowsLoopbackAudioManager) windowsLoopbackAudioManager.stop().catch(() => {});
  if (meetingAecManager) meetingAecManager.stop().catch(() => {});
  if (ipcHandlers) ipcHandlers._cleanupTextEditMonitor();
  if (textEditMonitor) textEditMonitor.stopMonitoring();
}
