import type { TestContext } from "node:test";

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
// This module has no side effects, so tests that install their own electron stub can use it.
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
