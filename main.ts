import { app, globalShortcut, dialog, ipcMain, powerMonitor } from "electron";
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
import { writeBbConnection, removeBbConnection } from "./src/helpers/bbWorkspace.js";
import { closeBbConnection } from "./src/helpers/bbConnection.js";
import { installAgentCli } from "./src/helpers/installAgentCli.js";
import { NoteReadService } from "./src/helpers/noteReadService.js";
import { GlobeKeyManager } from "./src/helpers/globeKeyManager.js";
import { GoogleCalendarManager } from "./src/helpers/googleCalendarManager.js";
import { MicrosoftCalendarManager } from "./src/helpers/microsoftCalendarManager.js";
import { AppleCalendarManager } from "./src/helpers/appleCalendarManager.js";
import { CalendarReminderScheduler } from "./src/helpers/calendarReminderScheduler.js";
import { MeetingProcessDetector } from "./src/helpers/meetingProcessDetector.js";
import { AudioActivityDetector } from "./src/helpers/audioActivityDetector.js";
import { MeetingCallDetector } from "./src/helpers/meetingCallDetector.js";
import {
  collectAudioCaptureHelperPids,
  createExcludedProcessIdProvider,
} from "./src/helpers/electronProcessIds.js";
import { registerMeetingHotkeyHandler } from "./src/helpers/meetingHotkeyIpcHandler.js";
import { AudioTapManager } from "./src/helpers/audioTapManager.js";
import { MeetingDetectionEngine } from "./src/helpers/meetingDetectionEngine.js";
import { i18nMain, changeLanguage } from "./src/helpers/i18nMain.js";
import { register as registerSidecar, shutdownAll } from "./src/helpers/sidecarRegistry.js";
import { reapStaleSidecars } from "./src/helpers/sidecarReaper.js";
import type { ModelManager } from "./src/helpers/modelManagerBridge.js";
import type { HotkeyManager } from "./src/helpers/hotkeyManager.js";

interface DotenvModule {
  config(options: { path: string; override?: boolean }): void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function loadDotenv(): DotenvModule {
  // SAFETY: dotenv is bundled by build-main.js; its config export is the
  // documented string-map helper, and no wire data crosses this seam.
  return require("dotenv") as DotenvModule;
}

loadDotenv().config({ path: path.join(app.getAppPath(), ".env") });

// Electron exposes `defaultApp` on its process object when the app runs from
// the electron binary; Node's process types don't declare it.
// SAFETY: Electron sets `defaultApp` on the same process object at runtime;
// the intersection only names that undeclared optional field.
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
    error: errorMessage(err),
  });
}

const VALID_CHANNELS = new Set(["development", "staging", "production"]);

const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = {
  development: "gristmill-dev",
  staging: "gristmill-staging",
  production: "gristmill",
} satisfies Record<string, string>;

const APP_NAME = "Gristmill";

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
      // SAFETY: the packaged app's own package.json is trusted local data; only
      // the optional gristmillChannel field is read and compared to a literal.
      const metadata = JSON.parse(
        fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")
      ) as { gristmillChannel?: string };

      if (metadata.gristmillChannel === "development") return "development";
    } catch (error) {
      debugLogger.warn("Could not read packaged app channel", {
        error: errorMessage(error),
      });
    }
  }

  const rawChannel = (process.env.GRISTMILL_CHANNEL || process.env.VITE_GRISTMILL_CHANNEL || "")
    .trim()
    .toLowerCase();

  if (VALID_CHANNELS.has(rawChannel)) {
    return rawChannel;
  }

  return inferDefaultChannel();
}

const APP_CHANNEL = resolveAppChannel();

process.env.GRISTMILL_CHANNEL = APP_CHANNEL;

function configureChannelUserDataPath(): void {
  const profileName = APP_CHANNEL === "production" ? APP_NAME : `${APP_NAME}-${APP_CHANNEL}`;
  const explicitPath = app.commandLine.getSwitchValue("user-data-dir");

  const isolatedPath = explicitPath
    ? path.resolve(explicitPath)
    : path.join(app.getPath("appData"), profileName);

  if (APP_CHANNEL !== "production") {
    // Check the resolved root and known writable paths before creating the
    // profile or reading its .env, including explicit smoke profiles.
    // SAFETY: lazy CommonJS seam; devSnapshot.js exports the named helpers.
    const devSnapshotModule =
      require("./src/helpers/devSnapshot.js") as typeof import("./src/helpers/devSnapshot.js");

    if (devSnapshotModule.devProfileHasUnsafePaths(isolatedPath)) {
      console.error("[devSnapshot] dev profile has an unsafe storage path; refusing to start.");
      app.exit(1);

      return;
    }
  }

  // app.setPath throws when the directory does not exist; a first dev launch
  // has no profile directory yet.
  fs.mkdirSync(isolatedPath, { recursive: true });
  app.setPath("userData", isolatedPath);
}

configureChannelUserDataPath();

// Early profile .env pass: startup selectors below (OAuth protocol, the dev
// snapshot refresh flag) read keys that may live in the profile .env. Values
// are not overridden — the post-snapshot pass below adds the rest (copied
// credentials) without clobbering anything set here.
loadDotenv().config({
  path: path.join(app.getPath("userData"), ".env"),
  override: false,
});

function getOAuthProtocol(): string {
  const fromEnv = (process.env.VITE_GRISTMILL_PROTOCOL || process.env.GRISTMILL_PROTOCOL || "")
    .trim()
    .toLowerCase();

  if (/^[a-z][a-z0-9+.-]*$/.test(fromEnv)) {
    return fromEnv;
  }

  // SAFETY: the `in` guard narrows APP_CHANNEL to the map's own keys before
  // the lookup, so the assertion only names that checked key.
  return APP_CHANNEL in DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL
    ? DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL[
        APP_CHANNEL as keyof typeof DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL
      ]
    : DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL.production;
}

const OAUTH_PROTOCOL = getOAuthProtocol();

function shouldRegisterProtocolWithAppArg(): boolean {
  return Boolean(electronProcess.defaultApp) || isElectronBinaryExec();
}

// Register custom protocol for OAuth callbacks.
function registerGristmillProtocol(): boolean {
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

const protocolRegistered = registerGristmillProtocol();

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
// production data. The snapshot runs AFTER the single-instance lock so two
// concurrent dev launches cannot race it; failures refuse to start (the app
// would otherwise create an empty dev database and mask the failure forever).
if (APP_CHANNEL === "development" && gotSingleInstanceLock) {
  // SAFETY: lazy CommonJS seam; devSnapshot.js exports the named helpers.
  const devSnapshot =
    require("./src/helpers/devSnapshot.js") as typeof import("./src/helpers/devSnapshot.js");

  // Explicit smoke profiles were checked before userData was set; they skip
  // production import. The default profile gets checked again by snapshot.
  const devOk = app.commandLine.getSwitchValue("user-data-dir")
    ? true
    : devSnapshot.snapshotProductionProfileForDev();

  if (!devOk) {
    console.error("[devSnapshot] dev profile check failed; exiting. The next launch retries.");
    app.exit(1);
  }
}

// Second profile .env pass after the dev snapshot: a first dev launch gets
// the copied credentials without a restart. override:false keeps anything the
// early pass or the system environment already set.
loadDotenv().config({
  path: path.join(app.getPath("userData"), ".env"),
  override: false,
});

// Keep the packaged development app visibly distinct in macOS menus.
const displayName = app.isPackaged && APP_CHANNEL === "development" ? "Gristmill Dev" : APP_NAME;

if (process.platform === "darwin" && app.getName() !== displayName) {
  app.setName(displayName);
}

// Add global error handling for uncaught exceptions
process.on("uncaughtException", (error: Error) => {
  console.error("Uncaught Exception:", error);

  // Don't exit the process for EPIPE errors as they're harmless
  if (error instanceof Error && "code" in error && error.code === "EPIPE") {
    return;
  }

  // For other errors, log and continue
  console.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Manager instances - initialized after app.whenReady()
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
  // SAFETY: lazy CommonJS seam; the bridge module's dual export carries the
  // ModelManager singleton on `default`, matching ModelManagerBridgeModule.
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
    debugLogger.warn("Failed to detect a login launch", {
      error: errorMessage(error),
    });

    return false;
  }
}

interface InitializedCoreManagers {
  environmentManager: EnvironmentManagerWithByok;
  windowManager: WindowManager;
  ipcHandlers: IPCHandlers;
  hotkeyManager: HotkeyManager;
  whisperManager: WhisperManager;
  parakeetManager: ParakeetManager;
}

function initializeCoreManagers(): InitializedCoreManagers {
  setupProductionPath();

  debugLogger.ensureFileLogging();

  // The BYOK accessors are generated onto the prototype from the key catalog
  // at module load; the intersection type makes that surface visible.
  // SAFETY: the constructor's prototype carries the generated BYOK accessors,
  // so the instance satisfies EnvironmentManagerWithByok.
  const initializedEnvironmentManager = new EnvironmentManager() as EnvironmentManagerWithByok;
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
      createExcludedProcessIdProvider(() => collectAudioCaptureHelperPids([audioTapManager])),
      () => initializedMeetingProcessDetector.getDetectedProcesses().length > 0
    ),
    initializedWindowManager,
    initializedDatabaseManager,
    { callDetector: new MeetingCallDetector() }
  );

  meetingDetectionEngine = initializedMeetingDetectionEngine;
  initializedWindowManager.meetingDetectionEngine = initializedMeetingDetectionEngine;
  initializedCalendarReminderScheduler.meetingDetectionEngine = initializedMeetingDetectionEngine;
  const initializedAudioTapManager = new AudioTapManager();
  audioTapManager = initializedAudioTapManager;

  // IPC handlers must be registered before window content loads
  const initializedHandlers = new IPCHandlers({
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
    getTrayManager: () => trayManager,
    oauthProtocolRegistered: protocolRegistered,
    oauthProtocol: OAUTH_PROTOCOL,
  });

  ipcHandlers = initializedHandlers;
  void initializedHandlers._meetingCoordinator?.startCompanion().catch((error) => {
    debugLogger.warn("Meet integration transport unavailable", { error: String(error) }, "meeting");
  });

  return {
    environmentManager: initializedEnvironmentManager,
    windowManager: initializedWindowManager,
    ipcHandlers: initializedHandlers,
    hotkeyManager: initializedWindowManager.hotkeyManager,
    whisperManager: initializedWhisperManager,
    parakeetManager: initializedParakeetManager,
  };
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

  // SAFETY: lazy CommonJS seam; onnxWorkerClient.js exports the named stop
  // helper, which is the only surface this module reads.
  const onnxWorkerClient = require("./src/helpers/onnxWorkerClient") as {
    stop(): Promise<void>;
  };

  registerSidecar("onnx", () => onnxWorkerClient.stop());
}

interface InitializedDeferredManagers {
  trayManager: TrayManager;
  globeKeyManager: GlobeKeyManager;
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers(): InitializedDeferredManagers {
  const initializedTrayManager = new TrayManager();
  trayManager = initializedTrayManager;

  const initializedGlobeKeyManager = new GlobeKeyManager({
    // Lets the listener put the user's macOS Globe action back after a crash.
    preferenceStatePath: path.join(app.getPath("userData"), "globe-preference-state.json"),
  });

  globeKeyManager = initializedGlobeKeyManager;

  if (process.platform === "darwin") {
    initializedGlobeKeyManager.on("error", (error: Error | null | undefined) => {
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

      // Fire-and-forget by contract: the alert is the last resort and has no
      // second failure path; showMessageBox resolves when dismissed.
      dialog
        .showMessageBox({
          type: "warning",
          title: i18nMain.t("startup.globeHotkey.title"),
          message: i18nMain.t("startup.globeHotkey.message"),
          detail: detailLines.join("\n\n"),
        })
        .catch((dialogError) =>
          debugLogger.error(
            "Failed to show the Globe hotkey warning",
            { error: errorMessage(dialogError) },
            "window"
          )
        );
    });
  }

  googleCalendarManager?.start();
  microsoftCalendarManager?.start();
  appleCalendarManager?.start();
  meetingDetectionEngine?.start();

  return { trayManager: initializedTrayManager, globeKeyManager: initializedGlobeKeyManager };
}

app.on("open-url", (event, url) => {
  event.preventDefault();

  if (!url.startsWith(`${OAUTH_PROTOCOL}://`)) return;

  void windowManager?.createControlPanelWindow().catch((error: Error) => {
    debugLogger.error("Failed to open control panel", { error: error.message }, "window");
  });
});

// Main application startup
async function startApp(): Promise<void> {
  dockManager.init();
  // Await so a stale sidecar is confirmed dead before new ones can spawn and
  // contend for its port or storage lock.
  await reapStaleSidecars();

  // Phase 1: Core managers + IPC handlers before windows
  const initialized = initializeCoreManagers();
  const initializedEnvironmentManager = initialized.environmentManager;
  const initializedWindowManager = initialized.windowManager;
  const initializedHandlers = initialized.ipcHandlers;
  const initializedHotkeyManager = initialized.hotkeyManager;
  const initializedWhisperManager = initialized.whisperManager;
  const initializedParakeetManager = initialized.parakeetManager;
  await initializedEnvironmentManager.init();
  registerSidecars();

  removeBbConnection(app.getPath("userData"));

  const initializedCliBridge = new CliBridge(
    {
      databaseManager: initializedHandlers.databaseManager,
      noteReadService: new NoteReadService(
        initializedHandlers.databaseManager,
        initializedHandlers.audioStorageManager.meetingRecordings
      ),
      deleteNoteInternal: (id) => initializedHandlers.deleteNoteInternal(id),
      deleteTranscriptionInternal: (id) => initializedHandlers.deleteTranscriptionInternal(id),
      noteWrites: initializedHandlers.noteWrites,
      approveAudioPath: (filePath) => initializedHandlers.approveAudioPath(filePath),
      transcribeLocalFile: (filePath, options) =>
        initializedHandlers.transcribeLocalFile(filePath, options),
      listLocalTranscriptionModels: () => initializedHandlers.listLocalTranscriptionModels(),
      audioStorageManager: initializedHandlers.audioStorageManager,
    },
    app.getPath("userData")
  );

  cliBridge = initializedCliBridge;

  try {
    await initializedCliBridge.start();
    const connection = initializedCliBridge.getConnection();

    if (connection) writeBbConnection(app.getPath("userData"), connection.port, connection.token);
  } catch (err) {
    debugLogger.error("CLI bridge failed to start", { error: errorMessage(err) });
    await initializedCliBridge.stop().catch(() => {});
    cliBridge = null;
  }

  // Isolated smoke profiles must not replace the user's installed command.
  if (app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
    try {
      installAgentCli();
    } catch (err) {
      debugLogger.error("Notes CLI launcher could not be installed", {
        error: errorMessage(err),
      });
    }
  }

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
  // Hydrate onboarding and settings even when the app starts in the tray.
  await initializedWindowManager.createControlPanelWindow({ show: !startMinimized });

  // Set up meeting mode hotkey
  const isMeetingPress = createHotkeyRepeatGate();

  const meetingHotkeyCallback = () => {
    if (!isMeetingPress()) return;

    if (initializedHotkeyManager.isInListeningMode()) return;

    // Fail closed during onboarding, like every other hotkey slot.
    if (!initializedWindowManager.isMeetingInputAllowed()) return;
    debugLogger.info("Meeting hotkey triggered", {}, "meeting");
    meetingDetectionEngine
      ?.startManualMeeting()
      .catch((error) =>
        debugLogger.error(
          "Failed to start a manual meeting",
          { error: errorMessage(error) },
          "meeting"
        )
      );
  };

  // The re-registration handler (settings UI path) lives in the typed owner;
  // the bootstrap slot registration below and the shared callback stay here,
  // along with the menu/tray/window wiring and the onboarding gate.
  registerMeetingHotkeyHandler({
    ipcMain,
    hotkeyManager: initializedHotkeyManager,
    environmentManager: initializedEnvironmentManager,
    meetingHotkeyCallback,
  });

  const savedMeetingKey = initializedEnvironmentManager.getMeetingKey() || "";

  if (savedMeetingKey) {
    const result = await initializedHotkeyManager.registerSlot(
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
  const initializedDeferred = initializeDeferredManagers();

  if (process.platform === "darwin") {
    // Restore a Globe preference marker left by a crash without starting any
    // Accessibility-protected event monitors during onboarding.
    await initializedDeferred.globeKeyManager.restoreLeftoverSystemPreference();
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
      whisperManager?.onWakeFromSleep().catch((err) => {
        debugLogger.debug("whisper wake re-warm error (non-fatal)", { error: errorMessage(err) });
      });
    }, WHISPER_WAKE_REWARM_DELAY_MS);
  });

  // Non-blocking server pre-warming; GPU backend resolved by the manager
  const whisperSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    whisperModel: process.env.LOCAL_WHISPER_MODEL,
  };

  initializedWhisperManager.initializeAtStartup(whisperSettings).catch((err) => {
    debugLogger.debug("Whisper startup init error (non-fatal)", { error: errorMessage(err) });
  });

  const parakeetSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    parakeetModel: process.env.PARAKEET_MODEL,
    language: process.env.DICTATION_LANGUAGE,
  };

  initializedParakeetManager.initializeAtStartup(parakeetSettings).catch((err) => {
    debugLogger.debug("Parakeet startup init error (non-fatal)", { error: errorMessage(err) });
  });

  const cleanupProvider = process.env.CLEANUP_PROVIDER;
  const cleanupLocalModel = process.env.LOCAL_CLEANUP_MODEL;

  if (cleanupProvider === "local" && cleanupLocalModel) {
    const modelManager = requireModelManager();
    modelManager.prewarmServer(cleanupLocalModel).catch((err) => {
      debugLogger.debug("llama-server pre-warm error (non-fatal)", { error: errorMessage(err) });
    });
  }

  const initializedTrayManager = initializedDeferred.trayManager;
  initializedTrayManager.setWindows(initializedWindowManager.controlPanelWindow);
  initializedTrayManager.setWindowManager(initializedWindowManager);

  if (databaseManager) initializedTrayManager.setCalendarSource(databaseManager);
  await initializedTrayManager.createTray();
}

// App event handlers
if (gotSingleInstanceLock) {
  app.on("second-instance", (_event, _commandLine) => {
    app
      .whenReady()
      .then(() => {
        if (!windowManager) {
          return;
        }

        return windowManager.createControlPanelWindow();
      })
      .catch((error) => {
        debugLogger.error("Failed to open control panel", { error: errorMessage(error) }, "window");
      });
  });

  app
    .whenReady()
    .then(() => {
      startApp().catch((error) => {
        console.error("Failed to start app:", error);
        dialog.showErrorBox(
          i18nMain.t("startup.error.title"),
          i18nMain.t("startup.error.message", { error: errorMessage(error) })
        );
        app.exit(1);
      });
    })
    .catch((error) => {
      console.error("Failed to await app readiness:", error);
      app.exit(1);
    });

  app.on("window-all-closed", () => {
    // macOS keeps the app available in the dock and menu bar.
  });

  app.on("activate", () => {
    windowManager?.createControlPanelWindow().catch((error) => {
      debugLogger.error("Failed to open control panel", { error: errorMessage(error) }, "window");
    });
  });

  let isShuttingDown = false;
  app.on("will-quit", (event) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    event.preventDefault();
    performSyncTeardown();
    // Fire-and-forget by contract: the will-quit handler cannot await, and the
    // shutdown path resolves a completion flag that drives the exit code.
    shutdownAll(async () => {
      await ipcHandlers?.shutdownMeetingWork();
    })
      .then((complete) => app.exit(complete ? 0 : 1))
      .catch((error) => {
        debugLogger.error("Shutdown failed", { error: errorMessage(error) }, "window");
        app.exit(1);
      });
  });
}

function performSyncTeardown(): void {
  removeBbConnection(app.getPath("userData"));
  closeBbConnection();

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
}
