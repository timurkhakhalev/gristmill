import {
  app,
  screen,
  BrowserWindow,
  dialog,
  type WebContents,
  type MessageBoxOptions,
} from "electron";
import debugLogger from "./debugLogger.js";
// Aliased: this class has an openExternalUrl method wrapping the helper.
import { openExternalUrl as openUrlInExternalBrowser } from "./externalUrlOpener.js";
import { HotkeyManager } from "./hotkeyManager.js";
import { DragManager, type DragOperationResult } from "./dragManager.js";
import { MenuManager } from "./menuManager.js";
import { DevServerManager } from "./devServerManager.js";
import { isAllowedAppNavigation, isExternalBrowserUrl } from "./navigationGuard.js";
import { pathToFileURL } from "url";
import dockManager from "./dockManager.js";
import { i18nMain } from "./i18nMain.js";
import { NotificationDismissTimer, getNotificationTimeoutMs } from "./notificationTimer.js";
import type { MeetingNotificationPrompt } from "./windowConfig.js";
import {
  CONTROL_PANEL_CONFIG,
  CONTROL_PANEL_MIN_SIZE,
  ONBOARDING_WINDOW_SIZES,
  NOTIFICATION_WINDOW_CONFIG,
  getMeetingNotificationWindowSize,
  WindowPositionUtil,
} from "./windowConfig.js";
import { centeredBounds, clampedBounds, type WindowBounds } from "./onboardingWindowBounds.js";
import fs from "fs";
import path from "path";
import { isDevelopmentChannel } from "./appChannel.js";
import type { TrayManager } from "./tray.js";
import { MeetingCompanionWindow } from "./meetingCompanionWindow.js";
import type { PendingNoteNavigation } from "../contracts/transcriptionData.js";
import type { PendingMeetingNoteNavigation } from "../contracts/meetingCoordinator.js";
import type { CalendarEvent } from "../contracts/calendar.js";

const AUTO_END_NOTIFICATION_LOAD_TIMEOUT_MS = 10_000;

// The window manager only needs these three engine entry points; the engine's
// detection algorithm stays its own owner (set from main.js).
export interface MeetingDetectionEngineCallbacks {
  handleNotificationTimeout?(notification?: MeetingNotificationPrompt | null): void;
  handleAutoEndNotificationClosed?(sessionId: string, options?: { flushQueued?: boolean }): void;
  handleDetectionNotificationClosed?(
    detectionId: string,
    options?: { flushQueued?: boolean }
  ): void;
}

export interface MeetingCaptureQuitGuard {
  isRecording(): boolean;
  stop(): Promise<{ success: boolean }>;
}

interface OnboardingWindowState {
  resizable: boolean;
  minimizable: boolean;
  maximizable: boolean;
  closable: boolean;
  fullscreenable: boolean;
  minimumSize: number[];
}

export class WindowManager {
  private devRendererSettingsSeeded = false;
  controlPanelWindow: BrowserWindow | null = null;
  _controlPanelVisibilityTimer: NodeJS.Timeout | null = null;
  _controlPanelShowRequested = true;
  _controlPanelLoadFailed = false;
  _onboardingRestoreBounds: WindowBounds | null = null;
  _onboardingWindowMode: string | null = null;
  _onboardingWindowState: OnboardingWindowState | null = null;
  // Fail closed until AppRouter has resolved persisted onboarding state and
  // committed the normal app. This covers the startup gap before React mounts.
  _onboardingActive = true;
  // Set by IPCHandlers so its demo session dies with the demo kind on every
  // teardown path (id-matched end, onboarding exit, control panel closed).
  notificationWindow: BrowserWindow | null = null;
  _notificationLoadTimeout: NodeJS.Timeout | null = null;
  _notificationDismissTimer: NotificationDismissTimer;
  notificationPrefs = {
    notificationsEnabled: true,
    notifyMeetingDetection: true,
    notifyCalendarReminders: true,
  };

  // Applies the notification toggles sent from the renderer. Returns nothing —
  // the detection gate is read separately so a resync of unchanged values does
  // not look like a change to the caller.
  setNotificationPreferences(
    prefs: Partial<{
      notificationsEnabled: boolean;
      notifyMeetingDetection: boolean;
      notifyCalendarReminders: boolean;
    }>
  ): void {
    for (const key of [
      "notificationsEnabled",
      "notifyMeetingDetection",
      "notifyCalendarReminders",
    ] as const) {
      const value = prefs[key];

      if (value === true || value === false) this.notificationPrefs[key] = value;
    }
  }

  // Meeting detection only serves the notification, so the master toggle and
  // the meeting toggle together gate the detector.
  notificationsGateDetection(): boolean {
    const { notificationsEnabled, notifyMeetingDetection } = this.notificationPrefs;

    return Boolean(notificationsEnabled && notifyMeetingDetection);
  }
  tray: TrayManager | null = null;
  hotkeyManager: HotkeyManager;
  dragManager: DragManager;
  isQuitting = false;
  meetingCaptureQuitGuard: MeetingCaptureQuitGuard | null = null;
  _quitConfirmationPromise: Promise<void> | null = null;
  loadErrorShown = false;
  _pendingMeetingNoteNavigation: PendingMeetingNoteNavigation | null = null;
  _pendingNoteNavigation: PendingNoteNavigation = null;
  meetingDetectionEngine: MeetingDetectionEngineCallbacks | null = null;
  _pendingNotificationData: MeetingNotificationPrompt | null = null;
  _notificationReadyFallback: NodeJS.Timeout | null = null;
  _preMeetingBounds: WindowBounds | null = null;
  meetingCompanion: MeetingCompanionWindow;

  constructor() {
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this.meetingCompanion = new MeetingCompanionWindow({
      getControlPanelWindow: () => this.controlPanelWindow,
      openNote: (payload) => this.queueNoteNavigation(payload),
    });
    this._notificationDismissTimer = new NotificationDismissTimer(() => {
      const notification = this._pendingNotificationData;
      // Dismiss first: an expiring restart offer lets the engine flush the
      // detections it was holding, and a prompt raised from that handler must
      // not be closed by this dismissal. The engine is not told the card closed
      // either — handleNotificationTimeout below settles this expiry, and a
      // close report here would flush the queue into a card that handler is
      // about to clear.
      this.dismissMeetingNotification({ notifyEngine: false });

      if (this.meetingDetectionEngine) {
        this.meetingDetectionEngine.handleNotificationTimeout?.(notification);
      }
    });

    app.on("before-quit", (event) => {
      if (this.isQuitting || !this.meetingCaptureQuitGuard?.isRecording()) {
        this.isQuitting = true;
        this.hotkeyManager.unregisterAll();

        return;
      }

      event.preventDefault();

      if (this._quitConfirmationPromise) return;
      const guard = this.meetingCaptureQuitGuard;
      this._quitConfirmationPromise = (async () => {
        const options: MessageBoxOptions = {
          type: "warning",
          title: i18nMain.t("dialog.meetingQuit.title"),
          message: i18nMain.t("dialog.meetingQuit.message"),
          buttons: [
            i18nMain.t("dialog.meetingQuit.stopAndQuit"),
            i18nMain.t("dialog.meetingQuit.cancel"),
          ],
          defaultId: 1,
          cancelId: 1,
        };

        const parent = this.controlPanelWindow;

        // A windowless macOS alert runs a blocking modal loop, starving capture IPC.
        if (parent && !parent.isDestroyed()) parent.show();

        const decision =
          parent && !parent.isDestroyed()
            ? await dialog.showMessageBox(parent, options)
            : await dialog.showMessageBox(options);

        if (decision.response !== 0) return;

        const stopped = await guard.stop();

        if (!stopped.success) {
          await dialog.showMessageBox({
            type: "error",
            message: i18nMain.t("dialog.meetingQuit.stopFailed"),
            buttons: ["OK"],
          });

          return;
        }

        this.isQuitting = true;
        this.hotkeyManager.unregisterAll();
        app.quit();
      })()
        .catch((error) => {
          debugLogger.error(
            "Meeting recording prevented safe quit",
            {
              error: error instanceof Error ? error.message : String(error),
            },
            "meeting"
          );
        })
        .finally(() => {
          this._quitConfirmationPromise = null;
        });
    });
  }

  setMeetingCaptureQuitGuard(guard: MeetingCaptureQuitGuard | null): void {
    this.meetingCaptureQuitGuard = guard;
  }

  stopMeetingCaptureFromMenu(): void {
    void this.meetingCaptureQuitGuard?.stop().catch((error) => {
      debugLogger.error(
        "Failed to stop meeting capture from the app menu",
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "meeting"
      );
    });
  }

  // Only the meeting prompt owns this: another overlay reporting its own hover
  // must not pause a countdown it cannot resume — it may be destroyed before
  // its pointer ever leaves.
  setNotificationInteractivity(sender: WebContents, interactive: boolean): void {
    const win = this.notificationWindow;

    if (!win || win.isDestroyed() || sender !== win.webContents) {
      return;
    }

    const togglesClickThrough = true;
    const hasFixedExpiry = this._pendingNotificationData?.kind === "auto-end";

    if (interactive) {
      if (togglesClickThrough) win.setIgnoreMouseEvents(false);

      if (!hasFixedExpiry) this._notificationDismissTimer.pause();
    } else {
      if (togglesClickThrough) win.setIgnoreMouseEvents(true, { forward: true });

      if (!hasFixedExpiry) this._notificationDismissTimer.resume();
    }
  }

  async loadWindowContent(window: BrowserWindow | null, isControlPanel = false): Promise<void> {
    if (!window || window.isDestroyed()) {
      throw new Error("Cannot load content into a missing window");
    }

    if (process.env.NODE_ENV === "development") {
      const appUrl = DevServerManager.getAppUrl(isControlPanel);

      if (!appUrl) {
        throw new Error("Dev server app URL is unavailable");
      }

      await DevServerManager.waitForDevServer();

      if (
        isControlPanel &&
        !this.devRendererSettingsSeeded &&
        isDevelopmentChannel() &&
        !app.commandLine.getSwitchValue("user-data-dir")
      ) {
        const release = await this.seedDevRendererSettings(window, appUrl);

        try {
          await window.loadURL(appUrl);
          this.devRendererSettingsSeeded = true;
        } finally {
          release();
        }

        return;
      }

      await window.loadURL(appUrl);
    } else {
      const fileInfo = DevServerManager.getAppFilePath(isControlPanel);

      if (!fileInfo) {
        throw new Error("Failed to get app file path");
      }

      if (!fs.existsSync(fileInfo.path)) {
        throw new Error(`HTML file not found: ${fileInfo.path}`);
      }

      await window.loadFile(fileInfo.path, { query: fileInfo.query });
    }
  }

  // The copied Chromium partition contains production's file:// localStorage,
  // while pnpm dev uses http://localhost. Read through Chromium itself, then
  // install missing keys before the HTTP page's first script runs. A durable
  // marker stops later launches from resurrecting keys removed in dev.
  private async seedDevRendererSettings(
    window: BrowserWindow,
    appUrl: string
  ): Promise<() => void> {
    const bridge = path.join(app.getAppPath(), "src", "dev-storage-bridge.html");
    await window.loadFile(bridge);

    // SAFETY: executeJavaScript returns `any`; the bridge page is app-owned and
    // builds the entries array, which the seed loop below reads as [key, value].
    const entries = (await window.webContents.executeJavaScript(
      "Array.from({ length: localStorage.length }, (_, i) => { const key = localStorage.key(i); return [key, localStorage.getItem(key)]; })"
    )) as Array<[string, string]>;

    if (entries.length === 0) return () => {};

    const origin = new URL(appUrl).origin;
    const marker = "gristmill.dev-renderer-settings-imported";

    const script = `if (location.origin === ${JSON.stringify(origin)}) {
      if (localStorage.getItem(${JSON.stringify(marker)}) !== "1") {
        for (const [key, value] of ${JSON.stringify(entries)}) {
          if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
        }
        localStorage.setItem(${JSON.stringify(marker)}, "1");
      }
    }`;

    const debuggerApi = window.webContents.debugger;
    debuggerApi.attach("1.3");

    try {
      await debuggerApi.sendCommand("Page.enable");
      await debuggerApi.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: script });
    } catch (error) {
      debuggerApi.detach();
      throw error;
    }

    return () => {
      if (debuggerApi.isAttached()) debuggerApi.detach();
    };
  }

  // Public gate for main.js's meeting hotkey call sites, which invoke the
  // detection engine directly rather than routing through a send method here.
  // "meeting" is never a demo kind, so this is simply "not during onboarding".
  isMeetingInputAllowed(): boolean {
    return !this._onboardingActive;
  }

  setHotkeyListeningMode(enabled: boolean): void {
    this.hotkeyManager.setListeningMode(enabled);
  }

  isUsingNativeShortcutHotkeys(): boolean {
    return this.hotkeyManager.isUsingNativeShortcut();
  }

  // The control panel is transparent on macOS, where Electron ignores
  // `-webkit-app-region: drag` entirely — the renderer recreates its titlebar
  // drag through the shared DragManager instead (useControlPanelWindowDrag).
  // No pill bookkeeping: position ownership below is main-window-only.
  async startControlPanelDrag(): Promise<DragOperationResult> {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    return await this.dragManager.startWindowDrag(this.controlPanelWindow);
  }

  async stopControlPanelDrag(): Promise<DragOperationResult> {
    return await this.dragManager.stopWindowDrag();
  }

  openExternalUrl(url: string, showError = true): void {
    openUrlInExternalBrowser(url).catch((error) => {
      if (showError) {
        dialog.showErrorBox(
          i18nMain.t("dialog.openLink.title"),
          i18nMain.t("dialog.openLink.message", {
            url,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    });
  }

  async createControlPanelWindow({ show = true }: { show?: boolean } = {}): Promise<void> {
    const existingWindow = this.controlPanelWindow;

    if (existingWindow && !existingWindow.isDestroyed()) {
      if (!show) return;
      this._controlPanelShowRequested = true;
      this._clearControlPanelVisibilityTimer();

      if (this._controlPanelLoadFailed || existingWindow.webContents.isCrashed())
        await this.loadControlPanel();

      if (
        !this._controlPanelShowRequested ||
        this.controlPanelWindow !== existingWindow ||
        existingWindow.isDestroyed()
      )
        return;

      if (existingWindow.isMinimized()) existingWindow.restore();

      if (!existingWindow.isVisible()) existingWindow.show();
      existingWindow.focus();
      dockManager.setControlPanelVisible(true);

      return;
    }

    this._controlPanelShowRequested = show;
    this.controlPanelWindow = new BrowserWindow({ ...CONTROL_PANEL_CONFIG, show: false });
    this.controlPanelWindow.setMinimumSize(
      CONTROL_PANEL_MIN_SIZE.width,
      CONTROL_PANEL_MIN_SIZE.height
    );
    this._onboardingRestoreBounds = null;
    this._onboardingWindowMode = null;
    this._onboardingWindowState = null;

    this.controlPanelWindow.webContents.on("will-navigate", (event, url) => {
      // getAppUrl() is null in packaged builds; exactly one of the two is set.
      const appFilePath = DevServerManager.getAppFilePath(true);

      const appUrl =
        DevServerManager.getAppUrl(true) ??
        (appFilePath ? pathToFileURL(appFilePath.path).href : null);

      if (isAllowedAppNavigation(url, appUrl)) {
        return;
      }

      event.preventDefault();

      if (isExternalBrowserUrl(url)) {
        this.openExternalUrl(url);
      } else {
        debugLogger.debug("Blocked untrusted navigation", { url }, "window");
      }
    });

    this.controlPanelWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternalUrl(url);

      return { action: "deny" };
    });

    this.controlPanelWindow.webContents.on("did-create-window", (childWindow, details) => {
      childWindow.close();

      if (details.url && !details.url.startsWith("devtools://")) {
        this.openExternalUrl(details.url, false);
      }
    });

    // Nothing else shows this window: ready-to-show deliberately doesn't, so the
    // renderer can pick the onboarding size first and avoid a visible
    // expanded → compact flash on fresh installs. That makes this the only
    // backstop if the renderer never gets that far — it loads but throws, a lazy
    // chunk fails, or auth/policy resolution never settles — so it must outlive
    // did-finish-load. Only a real show cancels it.
    if (show) {
      this._controlPanelVisibilityTimer = setTimeout(() => {
        this._showControlPanel();
      }, 10000);
    }

    this.controlPanelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.hideControlPanelToTray();
      }
    });

    this.controlPanelWindow.on("closed", () => {
      this._clearControlPanelVisibilityTimer();
      this.controlPanelWindow = null;
      this._onboardingActive = true;
      this._hideNormalAppSurfaces();
      this._onboardingRestoreBounds = null;
      this._onboardingWindowMode = null;
      this._onboardingWindowState = null;
      dockManager.setControlPanelVisible(false);
    });

    MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => {
      this.openSettings().catch((error) =>
        debugLogger.error(
          "Failed to open settings",
          { error: error instanceof Error ? error.message : String(error) },
          "window"
        )
      );
    });

    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) return;
      // Every fresh document starts unresolved. AppRouter releases the gate
      // only after it commits the normal app, so OAuth/onboarding reloads cannot
      // expose meeting hotkeys or popup surfaces in between.
      this.setOnboardingActive(true);
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    });

    this.controlPanelWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }

        if (this._controlPanelShowRequested && process.env.NODE_ENV !== "development") {
          this.showLoadFailureDialog("Control panel", errorCode, errorDescription, validatedURL);
        }

        // Show it regardless: a failed load can't reach the renderer path that
        // normally does, and a hidden window leaves the failure invisible.
        this._showControlPanel();
      }
    );

    this.controlPanelWindow.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "crashed" || details.reason === "killed" || details.reason === "oom") {
        debugLogger.error(
          "Control panel renderer process gone",
          { reason: details.reason, exitCode: details.exitCode },
          "window"
        );
        // The renderer owned any running demo; without this, its stale session
        // keeps swallowing dictations after the reload.
        setTimeout(() => {
          this.loadControlPanel().catch((error) =>
            debugLogger.error(
              "Failed to reload the control panel",
              { error: error instanceof Error ? error.message : String(error) },
              "window"
            )
          );
        }, 1000);
      }
    });

    this.controlPanelWindow.on("show", () => {
      if (this.controlPanelWindow?.webContents.isCrashed()) {
        debugLogger.error("Control panel crashed, reloading on show", undefined, "window");
        this.loadControlPanel().catch((error) =>
          debugLogger.error(
            "Failed to reload the crashed control panel",
            { error: error instanceof Error ? error.message : String(error) },
            "window"
          )
        );
      }
    });

    try {
      await this.loadControlPanel();
    } catch (error) {
      if (show) throw error;
      this._controlPanelLoadFailed = true;
      this.setOnboardingActive(true);
      debugLogger.error(
        "Hidden control panel failed to load",
        { error: error instanceof Error ? error.message : String(error) },
        "window"
      );
    }
  }

  async loadControlPanel(): Promise<void> {
    const window = this.controlPanelWindow;
    this._controlPanelLoadFailed = false;

    try {
      await this.loadWindowContent(window, true);
    } catch (error) {
      if (this.controlPanelWindow === window) {
        this._controlPanelLoadFailed = true;
        this.setOnboardingActive(true);
      }

      throw error;
    }
  }

  setOnboardingActive(active: boolean): boolean {
    this._onboardingActive = active === true;

    if (this._onboardingActive) this._hideNormalAppSurfaces();

    return true;
  }

  _hideNormalAppSurfaces(): void {
    this.dismissMeetingNotification({ flushQueued: false });
  }

  _clearControlPanelVisibilityTimer(): void {
    if (this._controlPanelVisibilityTimer) clearTimeout(this._controlPanelVisibilityTimer);

    this._controlPanelVisibilityTimer = null;
  }

  _showControlPanel(): void {
    if (!this._controlPanelShowRequested) return;
    const win = this.controlPanelWindow;

    if (!win || win.isDestroyed()) return;
    // Cancel the backstop either way: once the window has been shown on purpose,
    // a later timer firing could pull it back out of the tray.
    this._clearControlPanelVisibilityTimer();

    if (win.isVisible()) return;
    win.show();
    win.focus();
    dockManager.setControlPanelVisible(true);
  }

  // Compact onboarding starts at smaller bounds, but both modes expose the
  // complete window-control contract so a frameless window never traps the
  // user in setup.
  _applyOnboardingWindowChrome(win: BrowserWindow, mode: string): void {
    const expanded = mode === "expanded";
    win.setResizable(true);
    win.setMinimizable(true);
    win.setMaximizable(true);
    win.setClosable(true);
    win.setFullScreenable(false);
    // Floor at the mode's canonical size so no step renders below the bounds
    // it was designed for — clamped to the work area, or a 1366x768-class
    // display could never fit (and setContentBounds would fight the minimum).
    const floor = expanded ? ONBOARDING_WINDOW_SIZES.EXPANDED : ONBOARDING_WINDOW_SIZES.COMPACT;
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    win.setMinimumSize(
      Math.min(floor.width, workArea.width),
      Math.min(floor.height, workArea.height)
    );

    if (process.platform === "darwin" && "setWindowButtonVisibility" in win) {
      win.setWindowButtonVisibility(true);
    }
  }

  setOnboardingWindowMode(mode: string): boolean {
    const win = this.controlPanelWindow;

    if (!win || win.isDestroyed()) return false;

    if (!new Set(["compact", "expanded", "restore"]).has(mode)) return false;

    if (mode !== "restore" && (win.isFullScreen() || win.isMaximized())) {
      // Entering onboarding from a maximized/fullscreen control panel must not
      // refuse: each mode is applied at its canonical centered bounds, which
      // only take effect from a normal window state. Both modes stay
      // maximizable, so the user can simply maximize again afterwards.
      if (win.isFullScreen()) win.setFullScreen(false);

      if (win.isMaximized()) win.unmaximize();
    }

    const current = win.getContentBounds();
    const { workArea } = screen.getDisplayMatching(win.getBounds());

    if (mode === "restore") {
      // A maximized/fullscreen window the user made keeps its bounds, but the
      // chrome state below must still be restored and the tracking cleared —
      // refusing outright left setFullScreenable(false) and onboarding's
      // minimum-size floor on the control panel for the rest of its life.
      if (!win.isFullScreen() && !win.isMaximized() && this._onboardingRestoreBounds) {
        win.setContentBounds(clampedBounds(this._onboardingRestoreBounds, workArea), true);
      }

      const state = this._onboardingWindowState;

      if (state) {
        win.setResizable(state.resizable);
        win.setMinimizable(state.minimizable);
        win.setMaximizable(state.maximizable);
        win.setClosable(state.closable);
        win.setFullScreenable(state.fullscreenable);
        win.setMinimumSize(
          Math.min(CONTROL_PANEL_MIN_SIZE.width, workArea.width),
          Math.min(CONTROL_PANEL_MIN_SIZE.height, workArea.height)
        );
      }

      if (process.platform === "darwin" && "setWindowButtonVisibility" in win) {
        win.setWindowButtonVisibility(true);
      }

      this._onboardingRestoreBounds = null;
      this._onboardingWindowMode = null;
      this._onboardingWindowState = null;
      this._showControlPanel();

      return true;
    }

    if (!this._onboardingRestoreBounds) {
      this._onboardingRestoreBounds = current;
      this._onboardingWindowState = {
        resizable: win.isResizable(),
        minimizable: win.isMinimizable(),
        maximizable: win.isMaximizable(),
        closable: win.isClosable(),
        fullscreenable: win.isFullScreenable(),
        minimumSize: win.getMinimumSize(),
      };
    }

    this._applyOnboardingWindowChrome(win, mode);

    if (this._onboardingWindowMode === mode) {
      this._showControlPanel();

      return true;
    }

    const target =
      mode === "compact" ? ONBOARDING_WINDOW_SIZES.COMPACT : ONBOARDING_WINDOW_SIZES.EXPANDED;

    const next = centeredBounds(current, target, workArea);

    if (
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    ) {
      this._onboardingWindowMode = mode;
      this._showControlPanel();

      return true;
    }

    win.setContentBounds(next, true);
    this._onboardingWindowMode = mode;
    this._showControlPanel();

    return true;
  }

  hideControlPanelToTray(): void {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return;
    }

    this._controlPanelShowRequested = false;
    // An explicit hide is authoritative: the visibility backstop exists to
    // rescue a window that never got shown, and letting it fire now would
    // pull the panel (and the Dock icon) back out of the tray.
    this._clearControlPanelVisibilityTimer();
    // A demo left running when the panel hides would keep swallowing normal
    // dictations (paste suppressed, transcripts rerouted to the demo session).
    this.controlPanelWindow.hide();
    dockManager.setControlPanelVisible(false);
  }

  async showMeetingNotification(
    promptData: MeetingNotificationPrompt,
    {
      autoDismiss = true,
      autoDismissAt = null,
    }: { autoDismiss?: boolean; autoDismissAt?: number | null } = {}
  ): Promise<boolean> {
    if (this._onboardingActive) return false;

    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      const previousWindow = this.notificationWindow;

      const replacedAutoEndSessionId =
        this._pendingNotificationData?.kind === "auto-end"
          ? this._pendingNotificationData.sessionId
          : null;

      this.notificationWindow = null;
      this._pendingNotificationData = null;
      previousWindow.close();

      if (replacedAutoEndSessionId) {
        this.meetingDetectionEngine?.handleAutoEndNotificationClosed?.(replacedAutoEndSessionId, {
          flushQueued: false,
        });
      }
    }

    this._notificationDismissTimer.cancel();

    if (this._notificationLoadTimeout) {
      clearTimeout(this._notificationLoadTimeout);
      this._notificationLoadTimeout = null;
    }

    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }

    const display = screen.getPrimaryDisplay();
    const notificationSize = getMeetingNotificationWindowSize(promptData);
    const position = WindowPositionUtil.getNotificationPosition(display, notificationSize);

    const win = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      ...notificationSize,
      ...position,
    });

    this.notificationWindow = win;

    // "closed" fires asynchronously, so a replaced prompt's window emits it
    // after the replacement already took over the reference and the countdown.
    win.on("closed", () => {
      if (this.notificationWindow !== win) return;
      const closedNotification = this._pendingNotificationData;

      const closedAutoEndSessionId =
        closedNotification?.kind === "auto-end" ? closedNotification.sessionId : null;

      const closedDetectionId =
        closedNotification?.kind === "detection" ? closedNotification.detectionId : null;

      this.notificationWindow = null;
      this._pendingNotificationData = null;
      this._notificationDismissTimer.cancel();

      if (this._notificationLoadTimeout) {
        clearTimeout(this._notificationLoadTimeout);
        this._notificationLoadTimeout = null;
      }

      if (this._notificationReadyFallback) {
        clearTimeout(this._notificationReadyFallback);
        this._notificationReadyFallback = null;
      }

      if (closedAutoEndSessionId) {
        this.meetingDetectionEngine?.handleAutoEndNotificationClosed?.(closedAutoEndSessionId);
      } else if (closedDetectionId) {
        this.meetingDetectionEngine?.handleDetectionNotificationClosed?.(closedDetectionId);
      }
    });

    win.setContentProtection(true);

    if (process.platform === "darwin") {
      win.setIgnoreMouseEvents(true, { forward: true });
    }

    // Notifications are independent of the hidden legacy renderer.
    WindowPositionUtil.setupAlwaysOnTop(win, { level: "screen-saver" });

    this._pendingNotificationData = promptData;

    // Everything past the load addresses `win` directly: a replacement taking
    // over mid-load must not have this prompt's data, countdown or force-show
    // applied to its window.
    let loadTimeout: NodeJS.Timeout | null = null;

    try {
      const loadNotification = async () => {
        if (process.env.NODE_ENV === "development") {
          await DevServerManager.waitForDevServer();

          if (this.notificationWindow !== win) return;
          await win.loadURL(`${DevServerManager.DEV_SERVER_URL}?meeting-notification=true`);

          return;
        }

        const fileInfo = DevServerManager.getAppFilePath(false);

        if (!fileInfo) {
          throw new Error("Failed to get the notification app file path");
        }

        await win.loadFile(fileInfo.path, {
          query: { ...fileInfo.query, "meeting-notification": "true" },
        });
      };

      const loadPromise = loadNotification();

      if (promptData?.kind === "auto-end") {
        const timeoutPromise = new Promise<never>((_, reject) => {
          loadTimeout = setTimeout(() => {
            if (this._notificationLoadTimeout === loadTimeout) {
              this._notificationLoadTimeout = null;
            }

            reject(new Error("Meeting auto-end notification load timed out"));
          }, AUTO_END_NOTIFICATION_LOAD_TIMEOUT_MS);
          this._notificationLoadTimeout = loadTimeout;
        });

        await Promise.race([loadPromise, timeoutPromise]);
      } else {
        await loadPromise;
      }
    } catch (error) {
      // A load aborted by our own replacement or dismissal is not a failure —
      // but the caller must still learn the notification never appeared.
      if (this.notificationWindow !== win) return false;
      this.dismissMeetingNotification();
      throw error;
    } finally {
      if (loadTimeout && this._notificationLoadTimeout === loadTimeout) {
        clearTimeout(loadTimeout);
        this._notificationLoadTimeout = null;
      }
    }

    if (this.notificationWindow !== win) return false;

    if (this._onboardingActive) {
      this.dismissMeetingNotification();

      return false;
    }

    const readyFallback = setTimeout(() => {
      if (this._notificationReadyFallback !== readyFallback) return;
      this._notificationReadyFallback = null;

      if (this._onboardingActive || this.notificationWindow !== win || win.isDestroyed()) return;
      debugLogger.warn("Notification renderer did not signal ready, force-showing", {}, "meeting");
      win.webContents.send("meeting-notification-data", promptData);
      win.showInactive();
      debugLogger.info(
        "Meeting notification window shown",
        { visible: win.isVisible() },
        "meeting"
      );
    }, 3000);

    this._notificationReadyFallback = readyFallback;

    if (autoDismiss) {
      this._notificationDismissTimer.start(
        autoDismissAt === null
          ? getNotificationTimeoutMs(promptData.source)
          : Math.max(0, autoDismissAt - Date.now())
      );
    }

    return true;
  }

  // Only the window that loaded the prompt may reveal it: a stale window's late
  // "ready" must not clear the fallback that would force-show its replacement.
  showNotificationWindow(ownerWebContents?: WebContents | null): void {
    if (this._onboardingActive) {
      this.dismissMeetingNotification();

      return;
    }

    const win = this.notificationWindow;

    if (!win || win.isDestroyed() || (ownerWebContents && win.webContents !== ownerWebContents)) {
      return;
    }

    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }

    win.showInactive();
    debugLogger.info("Meeting notification window shown", { visible: win.isVisible() }, "meeting");
  }

  dismissMeetingNotification({ notifyEngine = true, flushQueued = true } = {}): void {
    const notification = this._pendingNotificationData;
    this._pendingNotificationData = null;

    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }

    this._notificationDismissTimer.cancel();

    if (this._notificationLoadTimeout) {
      clearTimeout(this._notificationLoadTimeout);
      this._notificationLoadTimeout = null;
    }

    const win = this.notificationWindow;
    this.notificationWindow = null;

    if (win && !win.isDestroyed()) win.close();

    if (notifyEngine && notification?.kind === "detection") {
      // SAFETY: a detection-kind prompt is only built alongside its detectionId
      // (meetingDetectionEngine sets both together), so it is present here.
      const detectionId = notification.detectionId as string;

      this.meetingDetectionEngine?.handleDetectionNotificationClosed?.(detectionId, {
        flushQueued,
      });
    }
  }

  dismissDetectionNotification(detectionId: string): void {
    if (
      this._pendingNotificationData?.kind === "detection" &&
      this._pendingNotificationData.detectionId === detectionId
    ) {
      this.dismissMeetingNotification();
    }
  }

  showMeetingAutoEndNotification({
    sessionId,
    expiresAt,
    reason,
  }: {
    sessionId: string;
    expiresAt: number;
    reason: string;
  }): Promise<boolean> {
    return this.showMeetingNotification(
      { kind: "auto-end", sessionId, expiresAt, reason },
      { autoDismissAt: expiresAt }
    );
  }

  dismissMeetingAutoEndNotification(sessionId: string): void {
    if (
      this._pendingNotificationData?.kind !== "auto-end" ||
      this._pendingNotificationData.sessionId !== sessionId
    ) {
      return;
    }

    this.dismissMeetingNotification();
  }

  isMeetingNotificationSender(sender: WebContents): boolean {
    const win = this.notificationWindow;

    return !!win && !win.isDestroyed() && win.webContents === sender;
  }

  sendToControlPanel(channel: string, data?: unknown): void {
    const win = this.controlPanelWindow;

    if (!win || win.isDestroyed()) return;

    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", () => {
        if (!win.isDestroyed()) win.webContents.send(channel, data);
      });
    } else {
      win.webContents.send(channel, data);
    }
  }

  async queueMeetingNoteNavigation(payload: PendingMeetingNoteNavigation): Promise<void> {
    this._pendingMeetingNoteNavigation = payload;
    await this.createControlPanelWindow();
    this.sendToControlPanel("meeting-note-navigation-pending");
  }

  consumePendingMeetingNoteNavigation(): PendingMeetingNoteNavigation | null {
    const payload = this._pendingMeetingNoteNavigation;
    this._pendingMeetingNoteNavigation = null;

    return payload;
  }

  async queueNoteNavigation(payload: NonNullable<PendingNoteNavigation>): Promise<void> {
    this._pendingNoteNavigation = payload;
    await this.createControlPanelWindow();
    this.sendToControlPanel("note-navigation-pending");
  }

  consumePendingNoteNavigation(): PendingNoteNavigation {
    const payload = this._pendingNoteNavigation;
    this._pendingNoteNavigation = null;

    return payload;
  }

  snapControlPanelToMeetingMode(): void {
    const win = this.controlPanelWindow;

    if (!win || win.isDestroyed()) return;
    this._preMeetingBounds = win.getBounds();
    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const width = Math.round(workArea.width / 3);
    win.setBounds({
      x: workArea.x + workArea.width - width,
      y: workArea.y,
      width,
      height: workArea.height,
    });
    win.focus();
  }

  restoreControlPanelFromMeetingMode(): void {
    const win = this.controlPanelWindow;

    if (!win || win.isDestroyed()) return;

    if (this._preMeetingBounds) {
      win.setBounds(this._preMeetingBounds);
      this._preMeetingBounds = null;
    } else {
      // CONTROL_PANEL_CONFIG declares both; the constructor options type keeps
      // them optional, so the documented defaults backstop an absent value.
      win.setSize(
        CONTROL_PANEL_CONFIG.width ?? CONTROL_PANEL_MIN_SIZE.width,
        CONTROL_PANEL_CONFIG.height ?? CONTROL_PANEL_MIN_SIZE.height
      );
      win.center();
    }
  }

  refreshLocalizedUi(): void {
    const openSettings = () => {
      this.openSettings().catch((error) =>
        debugLogger.error(
          "Failed to open settings",
          { error: error instanceof Error ? error.message : String(error) },
          "window"
        )
      );
    };

    MenuManager.setupMainMenu(openSettings);

    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      MenuManager.setupControlPanelMenu(this.controlPanelWindow, openSettings);
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    }
  }

  async requestNewNote(): Promise<void> {
    await this.createControlPanelWindow();
    this.sendToControlPanel("tray-new-note");
  }

  async requestOpenCalendarEvent(event: CalendarEvent): Promise<void> {
    await this.createControlPanelWindow();
    this.sendToControlPanel("tray-open-event", event);
  }

  async openSettings(): Promise<void> {
    await this.createControlPanelWindow();
    this.sendToControlPanel("show-settings");
  }

  showLoadFailureDialog(
    windowName: string,
    errorCode: number,
    errorDescription: string,
    validatedURL: string
  ): void {
    if (this.loadErrorShown) {
      return;
    }

    this.loadErrorShown = true;

    const detailLines = [
      i18nMain.t("dialog.loadFailure.detail.window", { windowName }),
      i18nMain.t("dialog.loadFailure.detail.error", { errorCode, errorDescription }),
      validatedURL ? i18nMain.t("dialog.loadFailure.detail.url", { url: validatedURL }) : null,
      i18nMain.t("dialog.loadFailure.detail.hint"),
    ].filter(Boolean);

    // Fire-and-forget by contract: the failure dialog has no second failure
    // path, and showMessageBox resolves once the user dismisses it.
    dialog
      .showMessageBox({
        type: "error",
        title: i18nMain.t("dialog.loadFailure.title"),
        message: i18nMain.t("dialog.loadFailure.message"),
        detail: detailLines.join("\n"),
      })
      .catch((error) =>
        debugLogger.error(
          "Failed to show the load failure dialog",
          { error: error instanceof Error ? error.message : String(error) },
          "window"
        )
      );
  }
}

module.exports = WindowManager;

// Dual export: legacy requires read this module as the class itself, while the
// TS graph imports the named class.
Object.assign(module.exports, { WindowManager });
