import Module from "node:module";
import path from "node:path";

// DatabaseManager requires electron at load time, which is unloadable under plain
// node, so the module loader hands it a stub whose userData path tests repoint.
let userDataDir: string = process.cwd();
// Optional explicit appData override (defaults to userData's parent, like the
// real app's channel profiles: userData = appData/<profile>).
let appDataDir: string | null = null;
let patched = false;

interface NodeModuleLike {
  id: string;
  path: string;
  exports: unknown;
  filename?: string;
  loaded?: boolean;
}
type ModuleParent = NodeModuleLike | null;
// ponytail: Module._load is an unsafe loader internal; keep it localized here
// until tests no longer need loader-level electron interception.
const moduleLoad = (Module as unknown as { _load: (request: string, parent: ModuleParent, isMain: boolean) => unknown })._load;

export function installElectronStub(): void {
  if (patched) return;
  patched = true;
  const originalLoad = moduleLoad;
  const patchedLoad = (request: string, parent: ModuleParent, isMain: boolean) => {
    if (request === "electron") {
      return {
        app: {
          getPath: (name: string) =>
            name === "appData" ? appDataDir || path.dirname(userDataDir) : userDataDir,
          getAppPath: () => process.cwd(),
          isReady: () => false,
        },
        BrowserWindow: {
          getAllWindows: () => [],
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  (Module as unknown as { _load: unknown })._load = patchedLoad;
}

// Must be set before DatabaseManager loads: it picks the dev database filename
// from NODE_ENV.
process.env.NODE_ENV = "test";

export function setUserDataDir(dir: string): void {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("setUserDataDir requires a non-empty path");
  }
  userDataDir = dir;
  appDataDir = null;
}

export function getUserDataDir(): string {
  return userDataDir;
}

export function setAppDataDir(dir: string): void {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("setAppDataDir requires a non-empty path");
  }
  appDataDir = dir;
}
