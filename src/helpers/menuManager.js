const { Menu } = require("electron");
const { i18nMain } = require("./i18nMain");

class MenuManager {
  static setupMainMenu(onOpenSettings) {
    const template = [
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
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit", label: i18nMain.t("menu.quit") },
          ],
        },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  static setupControlPanelMenu(controlPanelWindow, onOpenSettings) {
    // OpenHercules targets macOS only, so the application menu is always used.
    const template = [
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
            { role: "reload" },
            { role: "forceReload" },
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

    const menu = Menu.buildFromTemplate(template);
    controlPanelWindow.setMenu(menu);
  }
}

module.exports = MenuManager;
