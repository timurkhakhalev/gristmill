import { app } from "electron";
import path from "path";
import { resolveDockVisibility } from "./dockPolicy.js";

// Single owner of the macOS Dock icon. Every caller that wants the icon shown
// or hidden goes through here, and the icon simply tracks the control panel.
//
// Callers report that state explicitly. The window's own "show"/"hide" events
// look like the obvious source to derive it from, but on macOS they are
// occlusion events: Electron only emits them from
// windowDidChangeOcclusionState, so they also fire when the panel is merely
// covered by another window, minimized, or on another Space. Deriving from
// them makes the icon flicker as the user switches windows.
class DockManager {
  private _controlPanelVisible = false;

  // Called once at startup, before any window exists: hides the Dock icon
  // until the control panel opens, so tray-only launches never show one.
  init(): void {
    this._controlPanelVisible = false;
    if (process.platform === "darwin" && process.env.OPENHERCULES_CHANNEL === "development") {
      const assetsPath = app.isPackaged ? process.resourcesPath : app.getAppPath();
      app.dock?.setIcon(path.join(assetsPath, "src", "assets", "iconDev.png"));
    }
    this._applyVisibility();
  }

  // Reported by every path that surfaces or hides the control panel.
  setControlPanelVisible(visible: boolean): void {
    this._controlPanelVisible = !!visible;
    this._applyVisibility();
  }

  private _applyVisibility(): void {
    const visible = resolveDockVisibility({
      platform: process.platform,
      controlPanelVisible: this._controlPanelVisible,
    });
    if (visible === null || !app.dock) return;

    if (visible) {
      app.dock.show();
    } else {
      // Electron swallows dock.hide() within 1s of a dock.show() (see DockHide
      // in browser_mac.mm), so closing the control panel right after opening it
      // leaves the icon up until the next hide. Working around that throttle
      // risks the macOS bug it exists to prevent: duplicate Dock icons.
      app.dock.hide();
    }
  }
}

const dockManager = new DockManager();
export default dockManager;
module.exports = dockManager;
