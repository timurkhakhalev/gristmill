import { Tray, Menu, nativeImage, app, BrowserWindow, type MenuItemConstructorOptions } from "electron";
import path from "path";
import fs from "fs";
import debugLogger from "./debugLogger.js";
import dockManager from "./dockManager.js";
import { i18nMain } from "./i18nMain.js";
import { MenuManager } from "./menuManager.js";
import type { WindowManager } from "./windowManager.js";
import type { CalendarEventRow } from "./database.js";
import { projectCalendarEvent } from "../contracts/calendar.js";

const MENU_REFRESH_MS = 30 * 1000;
const TITLE_MAX_CHARS = 16;
const UPCOMING_WINDOW_MINUTES = 48 * 60;

export interface TrayCalendarSource {
  getUpcomingEvents(windowMinutes?: number): CalendarEventRow[];
}

// Minimal structural slice of the lazy "canvas" fallback dependency.
interface CanvasLike {
  getContext(type: string): {
    fillStyle: string;
    beginPath(): void;
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
    fill(): void;
  };
  toBuffer(format: string): Buffer;
}

export class TrayManager {
  tray: Tray | null = null;
  controlPanelWindow: BrowserWindow | null = null;
  windowManager: WindowManager | null = null;
  attachedControlPanels = new WeakSet<BrowserWindow>();
  createControlPanelCallback: (() => Promise<void> | void) | undefined;
  meetingCaptureActive = false;
  stopMeetingCapture: (() => void) | null = null;
  calendarSource: TrayCalendarSource | null = null;
  refreshTimer: NodeJS.Timeout | null = null;
  // Replacing the menu while it is open dismisses it, so refreshes wait.
  menuOpen = false;

  setCalendarSource(source: TrayCalendarSource): void {
    this.calendarSource = source;
    this.updateTrayMenu();
  }

  formatDuration(ms: number): string {
    const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return h > 0
      ? i18nMain.t("tray.durationHoursMinutes", { h, m })
      : i18nMain.t("tray.durationMinutes", { m });
  }

  formatTimeRange(event: CalendarEventRow): string {
    const fmt = new Intl.DateTimeFormat(i18nMain.language ?? undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${fmt.format(new Date(event.start_time))} - ${fmt.format(new Date(event.end_time))}`;
  }

  // Events that have not started yet, soonest first (in-progress ones are skipped).
  getFutureEvents(now = Date.now()): CalendarEventRow[] {
    if (!this.calendarSource) return [];
    try {
      return this.calendarSource
        .getUpcomingEvents(UPCOMING_WINDOW_MINUTES)
        .filter((event) => new Date(event.start_time).getTime() > now)
        .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    } catch (error) {
      debugLogger.error("Failed to read upcoming events", { error: (error as Error).message }, "tray");
      return [];
    }
  }

  buildMeetingMenuItems(now = Date.now()): MenuItemConstructorOptions[] {
    const events = this.getFutureEvents(now);
    if (!events.length) return [];

    const [next, ...rest] = events;
    const items: MenuItemConstructorOptions[] = [
      {
        label: i18nMain.t("tray.startsIn", {
          time: this.formatDuration(new Date(next.start_time).getTime() - now),
        }),
        enabled: false,
      },
      this.meetingItem(next),
    ];

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = tomorrow.toDateString();
    const tomorrowEvent = [next, ...rest].find(
      (event) => new Date(event.start_time).toDateString() === tomorrowKey && event !== next
    );
    if (tomorrowEvent) {
      items.push(
        { type: "separator" },
        { label: i18nMain.t("tray.tomorrow"), enabled: false },
        this.meetingItem(tomorrowEvent)
      );
    }
    items.push({ type: "separator" });
    return items;
  }

  meetingItem(event: CalendarEventRow): MenuItemConstructorOptions {
    return {
      label: event.summary || "—",
      sublabel: this.formatTimeRange(event),
      click: () => {
        const projected = projectCalendarEvent(event);
        if (projected) void this.windowManager?.requestOpenCalendarEvent(projected);
        else void this.showControlPanelFromTray();
      },
    };
  }

  updateTrayTitle(now = Date.now()): void {
    if (!this.tray || process.platform !== "darwin") return;
    const next = this.getFutureEvents(now)[0];
    if (!next) {
      this.tray.setTitle("");
      return;
    }
    const name = next.summary ?? "";
    const short = name.length > TITLE_MAX_CHARS ? `${name.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : name;
    const time = i18nMain.t("tray.inTime", {
      time: this.formatDuration(new Date(next.start_time).getTime() - now),
    });
    this.tray.setTitle(short ? `${short} • ${time}` : time);
  }

  startRefreshTimer(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => this.updateTrayMenu(), MENU_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  setMeetingCaptureStatus(active: boolean, stop?: () => void): void {
    this.meetingCaptureActive = active;
    this.stopMeetingCapture = active ? stop ?? null : null;
    MenuManager.setMeetingCaptureStatus(active, this.stopMeetingCapture ?? undefined);
    this.updateTrayMenu();
  }

  setWindows(controlPanelWindow: BrowserWindow | null): void {
    this.controlPanelWindow = controlPanelWindow;


    if (this.controlPanelWindow) {
      this.attachControlPanelListeners(this.controlPanelWindow);
    }

    this.updateTrayMenu?.();
  }

  setWindowManager(windowManager: WindowManager): void {
    this.windowManager = windowManager;
  }

  setCreateControlPanelCallback(callback: () => Promise<void> | void): void {
    this.createControlPanelCallback = callback;
  }

  attachControlPanelListeners(window: BrowserWindow | null): void {
    if (!window || this.attachedControlPanels.has(window)) {
      return;
    }

    this.attachedControlPanels.add(window);

    window.on("show", () => {
      this.updateTrayMenu?.();
    });

    window.on("hide", () => {
      this.updateTrayMenu?.();
    });

    window.on("minimize", () => {
      this.updateTrayMenu?.();
    });

    window.on("restore", () => {
      this.updateTrayMenu?.();
    });

    // Electron emits "destroyed" from its EventEmitter base but doesn't declare it.
    (window as unknown as NodeJS.EventEmitter).on("destroyed", () => {
      this.controlPanelWindow = null;
      this.updateTrayMenu?.();
    });  }

  syncControlPanelWindow(): BrowserWindow | null {
    if (this.windowManager) {
      this.controlPanelWindow = this.windowManager.controlPanelWindow || this.controlPanelWindow;
    }
    this.attachControlPanelListeners(this.controlPanelWindow);
    return this.controlPanelWindow;
  }

  isControlPanelVisible(): boolean {
    const win = this.syncControlPanelWindow();
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  }

  // On Linux a window parked on another workspace still reports as visible, so
  // the first click hides it and the next re-shows it on the current workspace.
  async toggleControlPanelFromTray(): Promise<void> {
    if (this.isControlPanelVisible()) {
      this.windowManager?.hideControlPanelToTray();
      return;
    }

    await this.showControlPanelFromTray();
  }

  async showControlPanelFromTray(): Promise<void> {
    try {
      this.syncControlPanelWindow();

      if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
        if (this.controlPanelWindow.isMinimized()) {
          this.controlPanelWindow.restore();
        }
        if (!this.controlPanelWindow.isVisible()) {
          this.controlPanelWindow.show();
        }
        this.controlPanelWindow.focus();
        dockManager.setControlPanelVisible(true);
        if (this.controlPanelWindow.webContents.isCrashed()) {
          this.controlPanelWindow.webContents.reload();
        }
        return;
      }

      if (this.createControlPanelCallback) {
        await this.createControlPanelCallback();
        this.syncControlPanelWindow();

        if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
          this.controlPanelWindow.show();
          this.controlPanelWindow.focus();
          dockManager.setControlPanelVisible(true);
        }
        return;
      }

      debugLogger.error("No control panel callback available", undefined, "tray");
    } catch (error) {
      debugLogger.error("Failed to open control panel", { error: (error as Error)?.message }, "tray");
    }
  }

  async createTray(): Promise<void> {
    try {
      const trayIcon = await this.loadTrayIcon();
      if (!trayIcon || trayIcon.isEmpty()) {
        debugLogger.error("Failed to load tray icon", undefined, "tray");
        return;
      }

      this.tray = new Tray(trayIcon);

      if (process.platform === "darwin") {
        this.tray.setIgnoreDoubleClickEvents(true);
      }

      this.updateTrayMenu();
      this.setupTrayEventHandlers();
      this.startRefreshTimer();
    } catch (error) {
      debugLogger.error("Error creating tray icon", { error: (error as Error).message }, "tray");
    }
  }

  async loadTrayIcon(): Promise<Electron.NativeImage | null> {
    const platform = process.platform;
    const isDevelopment = process.env.OPENHERCULES_CHANNEL === "development";

    const candidatePaths: string[] = [];

    if (platform === "darwin") {
      if (isDevelopment) {
        candidatePaths.push(
          path.join(process.resourcesPath, "src", "assets", "iconDevMenubar@3x.png"),
          path.join(app.getAppPath(), "src", "assets", "iconDevMenubar@3x.png")
        );
      } else {
        candidatePaths.push(
          path.join(process.resourcesPath, "src", "assets", "iconTemplate@3x.png"),
          path.join(process.resourcesPath, "assets", "iconTemplate@3x.png"),
          path.join(
            process.resourcesPath,
            "app.asar.unpacked",
            "src",
            "assets",
            "iconTemplate@3x.png"
          ),
          path.join(app.getAppPath(), "src", "assets", "iconTemplate@3x.png")
        );
      }
    } else {
      const fileName = platform === "win32" ? "icon.ico" : "icon.png";
      if (isDevelopment) {
        candidatePaths.push(
          path.join(app.getAppPath(), "src", "assets", fileName),
          path.join(app.getAppPath(), "src", "assets", "icon.png")
        );
      } else {
        candidatePaths.push(
          path.join(process.resourcesPath, "src", "assets", fileName),
          path.join(process.resourcesPath, "assets", fileName),
          path.join(process.resourcesPath, "app.asar.unpacked", "src", "assets", fileName),
          path.join(app.getAppPath(), "src", "assets", fileName)
        );
      }
    }

    for (const testPath of candidatePaths) {
      try {
        if (fs.existsSync(testPath)) {
          const icon = nativeImage.createFromPath(testPath);
          if (icon && !icon.isEmpty()) {
            if (platform === "darwin") {
              icon.setTemplateImage(!isDevelopment);
            }
            debugLogger.debug("Using tray icon", { path: testPath }, "tray");
            return icon;
          }
        }
      } catch (error) {
        debugLogger.error(
          "Error checking tray icon path",
          { path: testPath, error: (error as Error).message },
          "tray"
        );
      }
    }

    debugLogger.error("Could not find tray icon in any expected location", undefined, "tray");
    return this.createFallbackIcon();
  }

  createFallbackIcon(): Electron.NativeImage | null {
    try {
      // Create a simple 16x16 PNG icon programmatically
      const { createCanvas } = require("canvas") as {
        createCanvas: (width: number, height: number) => CanvasLike;
      };
      const canvas = createCanvas(16, 16);
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.arc(8, 8, 6, 0, 2 * Math.PI);
      ctx.fill();

      const buffer = canvas.toBuffer("image/png");
      const fallbackIcon = nativeImage.createFromBuffer(buffer);
      debugLogger.info("Created fallback tray icon", undefined, "tray");
      return fallbackIcon;
    } catch {
      debugLogger.warn("Canvas not available, creating minimal fallback icon", undefined, "tray");
      // Create a minimal 16x16 black square PNG as fallback
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x91, 0x68, 0x36, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x28, 0x53, 0x63, 0x08,
        0x05, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      const fallbackIcon = nativeImage.createFromBuffer(pngData);
      debugLogger.info("Created minimal fallback tray icon", undefined, "tray");
      return fallbackIcon;
    }
  }

  buildContextMenuTemplate(): MenuItemConstructorOptions[] {

    return [
      ...this.buildMeetingMenuItems(),
      {
        label: this.isControlPanelVisible()
          ? i18nMain.t("tray.hideControlPanel")
          : i18nMain.t("tray.openControlPanel"),
        click: () => {
          void this.toggleControlPanelFromTray();
        },
      },
      {
        label: i18nMain.t("tray.newNote"),
        click: () => {
          void this.windowManager?.requestNewNote();
        },
      },
      {
        label: i18nMain.t("tray.settings"),
        click: () => {
          void this.windowManager?.openSettings();
        },
      },
      ...(this.meetingCaptureActive
        ? [
            { label: i18nMain.t("tray.recordingStatus"), enabled: false } as MenuItemConstructorOptions,
            {
              label: i18nMain.t("tray.stopRecording"),
              click: () => this.stopMeetingCapture?.(),
            } as MenuItemConstructorOptions,
            { type: "separator" } as MenuItemConstructorOptions,
          ]
        : []),
      { type: "separator" },
      {
        label: i18nMain.t("tray.quit"),
        click: () => {
          debugLogger.info("Quitting app via tray menu", undefined, "tray");
          app.quit();
        },
      },
    ];
  }

  updateTrayMenu(): void {
    if (!this.tray || this.menuOpen) return;

    const contextMenu = Menu.buildFromTemplate(this.buildContextMenuTemplate());
    contextMenu.on("menu-will-show", () => {
      this.menuOpen = true;
    });
    contextMenu.on("menu-will-close", () => {
      this.menuOpen = false;
    });
    this.tray.setToolTip(i18nMain.t("tray.tooltip"));
    this.tray.setContextMenu(contextMenu);
    this.updateTrayTitle();
  }

  setupTrayEventHandlers(): void {
    if (!this.tray) {
      return;
    }

    if (process.platform !== "darwin") {
      this.tray.on("click", () => {
        void this.toggleControlPanelFromTray();
      });
    }

    // Electron emits "destroyed" from its EventEmitter base but doesn't declare it.
    (this.tray as unknown as NodeJS.EventEmitter).on("destroyed", () => {
      debugLogger.debug("Tray icon destroyed", undefined, "tray");
      this.tray = null;
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    });
  }
}

module.exports = TrayManager;
module.exports.TrayManager = TrayManager;
