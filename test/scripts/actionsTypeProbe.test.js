const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

// Compiles a probe source under the strict main settings and returns all
// program diagnostics. Negative probes expect specific codes; positive
// probes expect none.
function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "actions-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

const IPC_MAIN = `declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };`;

test("an incomplete database dependency fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerActionsHandlers } from "./src/helpers/actionsIpcHandlers.js";

${IPC_MAIN}

// A database missing deleteAction would leave the delete channel dead while
// the rest keep working; the compiler must reject the registration.
registerActionsHandlers(ipcMain, {
  database: {
    getActions: () => [],
    getAction: () => null,
    createAction: () => ({ success: true, action: null }),
    updateAction: () => ({ success: true, action: null }),
  },
});
`);
  try {
    assert.deepEqual(codes, [2741]);
  } finally {
    cleanup();
  }
});

test("a wrong bridge-level call fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { createActionsBridge } from "./src/preload/actionsBridge.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createActionsBridge(ipcRendererLike);

// createAction requires name, description and prompt; two of three is a
// compile-time error, not a silent empty action.
bridge.createAction("Only a name", "and a description");
`);
  try {
    // 2554: too few arguments; 2345: the missing third argument's slot
    // carries an incompatible unknown in the bundled signature order.
    assert.deepEqual(codes, [2345, 2554]);
  } finally {
    cleanup();
  }
});

test("the full contract registration and bridge compile under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerActionsHandlers } from "./src/helpers/actionsIpcHandlers.js";
import { createActionsBridge } from "./src/preload/actionsBridge.js";

${IPC_MAIN}

registerActionsHandlers(ipcMain, {
  database: {
    getActions: () => [
      {
        id: 1,
        name: "n",
        description: "d",
        prompt: "p",
        icon: "sparkles",
        is_builtin: 1,
        sort_order: 0,
        translation_key: null,
        created_at: "c",
        updated_at: "u",
      },
    ],
    getAction: (id: unknown) => (Number(id) > 0 ? null : null),
    createAction: (name: unknown, description: unknown, prompt: unknown, icon: unknown) => {
      void name; void description; void prompt; void icon;
      return { success: true, action: null };
    },
    updateAction: (id: unknown, updates: unknown) => {
      void id; void updates;
      return { success: false, action: null };
    },
    deleteAction: (id: unknown) => {
      void id;
      return { success: false };
    },
  },
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};
const bridge = createActionsBridge(ipcRendererLike);
const dispose = bridge.onActionDeleted((payload) => void payload.id);
dispose();
void bridge.getActions().then((rows) => rows.map((r) => r.translation_key));
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
