import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { installElectronStub, setUserDataDir } from "./electronStub.js";

const REQUIRED_DB_FAILURE =
  "DB-backed tests were required (REQUIRE_DB_TESTS is set) but the better-sqlite3 native " +
  "binding could not be loaded, so this test would have been skipped instead of run. In CI " +
  "this almost always means the step that rebuilds better-sqlite3 for the runner's Node " +
  '("pnpm --dir node_modules/better-sqlite3 exec prebuild-install") is missing or ' +
  "failed. Restore that step instead of deleting this check: without it every DB test " +
  "skips and the suite stays green with no database coverage. Underlying error: ";

interface NativeBindingError {
  message: string;
  code: string | null;
}

// Loader failures surface as Error or bare string codes; the probe reads the
// two fields the skip decision needs. The unknown parameter is the catch-site
// contract (narrow exact-file override below documents this boundary).
function parseNativeBindingError(error: unknown): NativeBindingError {
  const message = error instanceof Error ? error.message : String(error);

  // SAFETY: loader failures put their errno-style code on the `code` field.
  const code = (error as { code?: string }).code ?? null;

  return { message, code };
}

function isNativeBindingUnavailable(error: NativeBindingError): boolean {
  return (
    error.message.includes("NODE_MODULE_VERSION") ||
    error.message.includes("Could not locate the bindings file") ||
    error.message.includes("ERR_DLOPEN_FAILED") ||
    error.code === "ERR_DLOPEN_FAILED"
  );
}

// Locally the binding is built for Electron's ABI, so a plain `node` run must skip. In CI the
// rebuild step makes it loadable, so a skip there means that step vanished and must fail.
export function skipOrFail(t: TestContext, error: unknown): void {
  const parsed = parseNativeBindingError(error);

  if (!isNativeBindingUnavailable(parsed)) {
    throw error;
  }

  if (process.env.REQUIRE_DB_TESTS) {
    throw new Error(REQUIRED_DB_FAILURE + parsed.message, { cause: error });
  }

  t.skip("better-sqlite3 native binding is not available for this Node runtime");
}

export { isNativeBindingUnavailable };

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
