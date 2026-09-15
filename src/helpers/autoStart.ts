// Launch at login for macOS. Decisions live in autoStartPolicy.ts.

import { app } from "electron";
import {
  getLoginItemArgs,
  resolveAutoStartState,
  wasLaunchedHidden,
} from "./autoStartPolicy.js";

function readLoginItemSettings() {
  return app.getLoginItemSettings({ args: getLoginItemArgs() });
}

function writeLoginItem(enabled: boolean) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: getLoginItemArgs(),
  });
}

export function getAutoStartState() {
  return resolveAutoStartState({
    loginItemSettings: readLoginItemSettings(),
  });
}

export function setAutoStartEnabled(enabled: boolean) {
  writeLoginItem(enabled);
}

export function wasLaunchedAtLoginHidden(): boolean {
  return wasLaunchedHidden({
    loginItemSettings: app.getLoginItemSettings(),
  });
}
