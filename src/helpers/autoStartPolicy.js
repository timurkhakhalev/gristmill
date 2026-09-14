// Launch-at-login decisions, kept free of Electron so they can be unit-tested.
//
// A login launch should come up in the tray. macOS reports it through
// wasOpenedAtLogin.

function getLoginItemArgs() {
  return [];
}

function resolveAutoStartState({ loginItemSettings }) {
  return {
    enabled: !!loginItemSettings.openAtLogin,
    // macOS 13+ routes login items through SMAppService, which can register an
    // item and still leave it awaiting approval in System Settings. Unsurfaced,
    // that just looks like a toggle that will not stick.
    requiresApproval: loginItemSettings.status === "requires-approval",
  };
}

// An entry written before this build carries no flag, so it no longer matches what
// we write and reads as disabled while still launching the app with its window
// showing. Rewriting reuses the same registry value name, so it re-points that
// entry rather than adding a second one.
// Whether the session started this process rather than the user.
function wasLaunchedHidden({ loginItemSettings }) {
  return !!loginItemSettings.wasOpenedAtLogin;
}

module.exports = {
  getLoginItemArgs,
  resolveAutoStartState,
  wasLaunchedHidden,
};
