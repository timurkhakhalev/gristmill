const Module = require("node:module");
const path = require("node:path");

// DatabaseManager requires electron at load time, which is unloadable under plain
// node, so the module loader hands it a stub whose userData path tests repoint.
let userDataDir = process.cwd();
// Optional explicit appData override (defaults to userData's parent, like the
// real app's channel profiles: userData = appData/<profile>).
let appDataDir = null;
let patched = false;

function installElectronStub() {
  if (patched) return;
  patched = true;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: (name) =>
            name === "appData" ? appDataDir || path.dirname(userDataDir) : userDataDir,
          getAppPath: () => process.cwd(),
          isReady: () => false,
        },
        BrowserWindow: {
          getAllWindows: () => [],
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

// Must be set before DatabaseManager loads: it picks the dev database filename
// from NODE_ENV.
process.env.NODE_ENV = "test";

function setUserDataDir(dir) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("setUserDataDir requires a non-empty path");
  }
  userDataDir = dir;
  appDataDir = null;
}

function getUserDataDir() {
  return userDataDir;
}

function setAppDataDir(dir) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("setAppDataDir requires a non-empty path");
  }
  appDataDir = dir;
}

module.exports = { installElectronStub, setUserDataDir, getUserDataDir, setAppDataDir };
