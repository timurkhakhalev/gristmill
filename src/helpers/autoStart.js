// Launch at login for macOS. Decisions live in autoStartPolicy.js.

const { app } = require("electron");
const {
  getLoginItemArgs,
  resolveAutoStartState,
  wasLaunchedHidden,
} = require("./autoStartPolicy");

function readLoginItemSettings() {
  return app.getLoginItemSettings({ args: getLoginItemArgs() });
}

function writeLoginItem(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: getLoginItemArgs(),
  });
}

function getAutoStartState() {
  return resolveAutoStartState({
    loginItemSettings: readLoginItemSettings(),
  });
}

function setAutoStartEnabled(enabled) {
  writeLoginItem(enabled);
}

function wasLaunchedAtLoginHidden() {
  return wasLaunchedHidden({
    loginItemSettings: app.getLoginItemSettings(),
  });
}

module.exports = {
  getAutoStartState,
  setAutoStartEnabled,
  wasLaunchedAtLoginHidden,
};
