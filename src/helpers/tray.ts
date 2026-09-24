import { Tray, Menu, nativeImage, app, BrowserWindow, type MenuItemConstructorOptions } from "electron";
import path from "path";
import fs from "fs";
import debugLogger from "./debugLogger.js";
import dockManager from "./dockManager.js";
import { i18nMain } from "./i18nMain.js";
import { MenuManager } from "./menuManager.js";
import type { WindowManager } from "./windowManager.js";

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
    } catch (error) {
      debugLogger.error("Error creating tray icon", { error: (error as Error).message }, "tray");
    }
  }

  async loadTrayIcon(): Promise<Electron.NativeImage | null> {
    const platform = process.platform;
    const isDevelopment = process.env.NODE_ENV === "development";

    const candidatePaths: string[] = [];

    if (platform === "darwin") {
      if (isDevelopment) {
        candidatePaths.push(path.join(app.getAppPath(), "src", "assets", "iconTemplate@3x.png"));
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
              icon.setTemplateImage(true);
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
      {
        label: this.isControlPanelVisible()
          ? i18nMain.t("tray.hideControlPanel")
          : i18nMain.t("tray.openControlPanel"),
        click: () => {
          void this.toggleControlPanelFromTray();
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
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate(this.buildContextMenuTemplate());
    this.tray.setToolTip(i18nMain.t("tray.tooltip"));
    this.tray.setContextMenu(contextMenu);
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
    });
  }
}

module.exports = TrayManager;
module.exports.TrayManager = TrayManager;
