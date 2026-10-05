// Issue #167: IntegrationsView disconnected accounts and cleared the Apple
// connection without checking the CalendarCommandResult the IPC resolves
// with — a resolved { success: false } (e.g. a DB write error during
// cleanup) removed the account from the UI while the main process kept it,
// and a thrown IPC failure escaped as an unhandled rejection with no error
// surface at all. The tests drive the real component callbacks (extracted
// from the source, since the view has no standalone hook boundary) against
// a stubbed store and electronAPI, covering resolved failure, thrown
// failure and success for Apple, Google and Microsoft.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const vm: typeof import("node:vm") = require("node:vm");

const root = path.join(__dirname, "../../../..");

const tick = () => new Promise((resolve) => setImmediate(resolve));

// The view closure stand-in: the extracted initializers are installed onto it
// below, so the seams the tests drive are declared and stubbed here.
interface Sandbox {
  handleDisconnect(email: string): Promise<void>;
  handleMicrosoftDisconnect(email: string): Promise<void>;
  handleAppleDisconnect(): Promise<void>;
  setDisconnectingEmail(value: string | null): void;
  setMsDisconnectingEmail(value: string | null): void;
  setDisconnectFailed(value: boolean): void;
  setGcalAccounts(accounts: Array<{ email: string }>): void;
  setMcalAccounts(accounts: Array<{ email: string }>): void;
  setAppleCalendarConnected(value: boolean): void;
  setAppleSourceNames(names: string[]): void;
  useSettingsStore: { getState(): Record<string, unknown> };
  window: { electronAPI: Record<string, unknown> };
  [key: string]: unknown;
}

// Extracts the component-scope disconnect callbacks by name and wires them
// into one sandbox that stands in for the component closure. The account
// setters round-trip through the fake store like React state would.
function buildSandbox({
  store,
  api,
}: {
  store: Record<string, unknown>;
  api: Record<string, unknown>;
}): Sandbox {
  const source = fs.readFileSync(path.join(root, "src/components/IntegrationsView.tsx"), "utf8");

  const ts: typeof import("typescript") = require(path.join(root, "node_modules/typescript"));

  const tree = ts.createSourceFile(
    "view.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  const initializers: Record<string, string> = {};

  const wanted = new Set([
    "handleDisconnect",
    "handleMicrosoftDisconnect",
    "handleAppleDisconnect",
  ]);

  const visit = (node: import("typescript").Node) => {
    if (ts.isVariableDeclaration(node) && wanted.has(node.name.getText(tree)) && node.initializer) {
      initializers[node.name.getText(tree)] = node.initializer.getText(tree);
    }

    ts.forEachChild(node, visit);
  };

  visit(tree);

  for (const name of wanted) {
    assert.ok(initializers[name], `${name} found in IntegrationsView`);
  }

  const sandbox: Sandbox = {
    useCallback: (fn: unknown) => fn,
    useSettingsStore: { getState: () => store },
    setDisconnectingEmail: () => {},
    setMsDisconnectingEmail: () => {},
    setDisconnectFailed: () => {},
    setGcalAccounts: () => {},
    setMcalAccounts: () => {},
    setAppleCalendarConnected: () => {},
    setAppleSourceNames: () => {},
    window: { electronAPI: api },
    // stubs for the seams the extracted initializers overwrite below
    handleDisconnect: async () => {},
    handleMicrosoftDisconnect: async () => {},
    handleAppleDisconnect: async () => {},
  };

  for (const name of wanted) {
    // The initializers are TS source; transpile the parenthesized expression
    // so vm parses plain JS.
    const expression = ts.transpileModule(`(${initializers[name]})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;

    sandbox[name] = vm.runInNewContext(expression, sandbox);
  }

  return sandbox;
}

// Installs recording setters: accounts and Apple state round-trip through the
// fake store, the failure flag is captured directly. Array.from copies the
// vm-context arrays the handlers produce into this realm so deepStrictEqual
// sees main-context prototypes.
function observe(sandbox: Sandbox, store: Record<string, unknown>) {
  const writes: {
    accounts?: Array<{ email: string }>;
    mcal?: Array<{ email: string }>;
    apple?: boolean;
    sourceNames?: string[];
    failed?: boolean;
  } = {};

  sandbox.setGcalAccounts = (accounts: Array<{ email: string }>) => {
    writes.accounts = Array.from(accounts, (account) => ({ email: account.email }));
    store.gcalAccounts = Array.from(accounts, (account) => ({ email: account.email }));
  };

  sandbox.setMcalAccounts = (accounts: Array<{ email: string }>) => {
    writes.mcal = Array.from(accounts, (account) => ({ email: account.email }));
    store.mcalAccounts = Array.from(accounts, (account) => ({ email: account.email }));
  };

  sandbox.setAppleCalendarConnected = (value: boolean) => {
    writes.apple = value;
    store.appleCalendarConnected = value;
  };

  sandbox.setAppleSourceNames = (names: string[]) => {
    writes.sourceNames = Array.from(names);
  };

  sandbox.setDisconnectFailed = (value: boolean) => {
    writes.failed = value;
  };

  return writes;
}

const EMAIL = "g@x.io";

const gcal = (result: unknown) => async () => result;

test("a resolved google disconnect failure keeps the account and flags the error", async () => {
  const store: Record<string, unknown> = { gcalAccounts: [{ email: EMAIL }] };
  const api = { gcalDisconnect: gcal({ success: false, error: "db locked" }) };
  const sandbox = buildSandbox({ store, api });
  const writes = observe(sandbox, store);

  await sandbox.handleDisconnect(EMAIL);
  await tick();
  assert.deepEqual(store.gcalAccounts, [{ email: EMAIL }], "the account stays in the store");
  assert.equal(writes.failed, true, "the failure surfaces through the error dialog flag");
  assert.equal(writes.accounts, undefined, "success-only account removal never ran");
});

test("a thrown google disconnect failure keeps the account and flags the error", async () => {
  const store: Record<string, unknown> = { gcalAccounts: [{ email: EMAIL }] };

  const api = {
    gcalDisconnect: async () => {
      throw new Error("ipc gone");
    },
  };

  const sandbox = buildSandbox({ store, api });
  const writes = observe(sandbox, store);

  await sandbox.handleDisconnect(EMAIL);
  await tick();
  assert.deepEqual(store.gcalAccounts, [{ email: EMAIL }]);
  assert.equal(writes.failed, true, "a rejection routes to the same failure dialog");
});

test("a successful google disconnect removes the account without the error flag", async () => {
  const store: Record<string, unknown> = { gcalAccounts: [{ email: EMAIL }] };
  const api = { gcalDisconnect: gcal({ success: true }) };
  const sandbox = buildSandbox({ store, api });
  const writes = observe(sandbox, store);

  await sandbox.handleDisconnect(EMAIL);
  await tick();
  assert.deepEqual(store.gcalAccounts, []);
  assert.equal(writes.failed, undefined);
});

test("a resolved microsoft disconnect failure keeps the account and flags the error", async () => {
  const store: Record<string, unknown> = { mcalAccounts: [{ email: EMAIL }] };
  const api = { mcalDisconnect: gcal({ success: false, error: "db locked" }) };
  const sandbox = buildSandbox({ store, api });
  const writes = observe(sandbox, store);

  await sandbox.handleMicrosoftDisconnect(EMAIL);
  await tick();
  assert.deepEqual(store.mcalAccounts, [{ email: EMAIL }], "the account stays in the store");
  assert.equal(writes.failed, true);
  assert.equal(writes.mcal, undefined);
});

test("a thrown microsoft disconnect failure keeps the account and flags the error", async () => {
  const store: Record<string, unknown> = { mcalAccounts: [{ email: EMAIL }] };

  const api = {
    mcalDisconnect: async () => {
      throw new Error("ipc gone");
    },
  };

  const sandbox = buildSandbox({ store, api });
  const writes = observe(sandbox, store);

  await sandbox.handleMicrosoftDisconnect(EMAIL);
  await tick();
  assert.deepEqual(store.mcalAccounts, [{ email: EMAIL }]);
  assert.equal(writes.failed, true);
});

test("a successful microsoft disconnect removes the account without the error flag", async () => {
  const store: Record<string, unknown> = { mcalAccounts: [{ email: EMAIL }] };
  const api = { mcalDisconnect: gcal({ success: true }) };
  const sandbox = buildSandbox({ store, api });
  const writes = observe(sandbox, store);

  await sandbox.handleMicrosoftDisconnect(EMAIL);
  await tick();
  assert.deepEqual(store.mcalAccounts, []);
  assert.equal(writes.failed, undefined);
});

test("a resolved apple disconnect failure keeps the connection and flags the error", async () => {
  const store: Record<string, unknown> = { appleCalendarConnected: true };
  const api = { acalDisconnect: gcal({ success: false, error: "db locked" }) };
  const sandbox = buildSandbox({ store, api });
  const writes = observe(sandbox, store);

  await sandbox.handleAppleDisconnect();
  await tick();
  assert.equal(store.appleCalendarConnected, true, "the connection stays");
  assert.equal(writes.failed, true);
  assert.equal(writes.apple, undefined, "the connected=false write never ran");
  assert.equal(writes.sourceNames, undefined);
});

test("a thrown apple disconnect failure keeps the connection and flags the error", async () => {
  const store: Record<string, unknown> = { appleCalendarConnected: true };

  const api = {
    acalDisconnect: async () => {
      throw new Error("ipc gone");
    },
  };

  const sandbox = buildSandbox({ store, api });
  const writes = observe(sandbox, store);

  await sandbox.handleAppleDisconnect();
  await tick();
  assert.equal(store.appleCalendarConnected, true);
  assert.equal(writes.failed, true);
  assert.equal(writes.apple, undefined);
});

test("a successful apple disconnect clears the connection without the error flag", async () => {
  const store: Record<string, unknown> = { appleCalendarConnected: true };
  const api = { acalDisconnect: gcal({ success: true }) };
  const sandbox = buildSandbox({ store, api });
  const writes = observe(sandbox, store);

  await sandbox.handleAppleDisconnect();
  await tick();
  assert.equal(store.appleCalendarConnected, false);
  assert.deepEqual(writes.sourceNames, [], "stale source names clear with the connection");
  assert.equal(writes.failed, undefined);
});
