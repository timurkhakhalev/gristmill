import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { installElectronStub, setUserDataDir } from "./electronStub.js";
import { skipOrFail } from "./nativeBinding.js";

export { isNativeBindingUnavailable, skipOrFail } from "./nativeBinding.js";

// Stub first, then load DatabaseManager through CJS require: an ESM import of
// database.ts would bypass the Module._load patch and reach the real electron
// binary, so the value import stays dynamic and ordered after installElectronStub().
installElectronStub();

type DatabaseManagerModule = typeof import("../../../src/helpers/database.js");

// SAFETY: the require loads this repo's own database module; the assertion
// restores the ESM type surface tsc knows for the same file.
const { DatabaseManager: DatabaseManagerClass } =
  require("../../../src/helpers/database.ts") as DatabaseManagerModule;

export { DatabaseManagerClass as DatabaseManager };

export type DatabaseManager = InstanceType<typeof DatabaseManagerClass>;

// A real DatabaseManager over a private tmpdir. Returns null when the caller
// must bail because skipOrFail marked the test skipped.
export function createDb(t: TestContext): DatabaseManager | null {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-sync-harness-"));
  setUserDataDir(userDataDir);

  // Probe first: a binding failure here is the loader's, not schema setup's.
  // better-sqlite3 ships no declarations; the structural surface here is new/close.
  type ProbeDatabase = { close(): void };

  // SAFETY: better-sqlite3 ships no declarations; the constructor probe pins
  // the structural surface this harness uses (new/close).
  const BetterSqlite = require("better-sqlite3") as new (path: string) => ProbeDatabase;

  try {
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    skipOrFail(t, error);

    return null;
  }

  let db: DatabaseManager;

  try {
    db = new DatabaseManagerClass();
  } catch (error) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    skipOrFail(t, error);

    return null;
  }

  t.after(() => {
    try {
      db.db?.close();
    } catch {
      // an already-closed handle must not mask the test's own failure
    }

    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  return db;
}
