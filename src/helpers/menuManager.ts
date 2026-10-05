import { Menu, BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { i18nMain } from "./i18nMain.js";

export class MenuManager {
  private static meetingCaptureActive = false;
  private static stopMeetingCapture: (() => void) | null = null;
  private static rebuildMenu: (() => void) | null = null;

  static setMeetingCaptureStatus(active: boolean, stop?: () => void): void {
    this.meetingCaptureActive = active;
    this.stopMeetingCapture = active ? (stop ?? null) : null;
    this.rebuildMenu?.();
  }

  private static meetingCaptureItems(): MenuItemConstructorOptions[] {
    if (!this.meetingCaptureActive) return [];

    return [
      { label: i18nMain.t("tray.recordingStatus"), enabled: false },
      { label: i18nMain.t("tray.stopRecording"), click: () => this.stopMeetingCapture?.() },
      { type: "separator" },
    ];
  }

  static setupMainMenu(onOpenSettings?: () => void): void {
    this.rebuildMenu = () => {
      const template: MenuItemConstructorOptions[] = [
        {
          label: i18nMain.t("menu.appLabel"),
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: i18nMain.t("menu.settings"),
              accelerator: "Command+,",
              click: () => onOpenSettings?.(),
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            ...this.meetingCaptureItems(),
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit", label: i18nMain.t("menu.quit") },
          ],
        },
      ];

      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    };

    this.rebuildMenu();
  }

  static setupControlPanelMenu(
    controlPanelWindow: BrowserWindow,
    onOpenSettings?: () => void,
    onStopMeetingCapture?: () => void
  ): void {
    this.stopMeetingCapture = this.meetingCaptureActive
      ? (onStopMeetingCapture ?? this.stopMeetingCapture)
      : null;
    this.rebuildMenu = () => {
      const template: MenuItemConstructorOptions[] = [
        {
          label: i18nMain.t("menu.appLabel"),
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: i18nMain.t("menu.settings"),
              accelerator: "Command+,",
              click: () => onOpenSettings?.(),
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            ...this.meetingCaptureItems(),
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit", label: i18nMain.t("menu.quit") },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "pasteAndMatchStyle" },
            { role: "delete" },
            { role: "selectAll" },
            { type: "separator" },
            {
              label: i18nMain.t("menu.speech"),
              submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
            },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "reload", enabled: !this.meetingCaptureActive },
            { role: "forceReload", enabled: !this.meetingCaptureActive },
            { role: "toggleDevTools" },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
        {
          label: "Window",
          submenu: [
            { role: "minimize" },
            { role: "close" },
            { type: "separator" },
            { role: "front" },
            { type: "separator" },
            { role: "window" },
          ],
        },
      ];

      controlPanelWindow.setMenu(Menu.buildFromTemplate(template));
    };

    this.rebuildMenu();
  }
}

module.exports = MenuManager;

module.exports.MenuManager = MenuManager;
