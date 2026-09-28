const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");

// Characterization for the five AI Actions catalog channels before the typed
// cutover. The JS handlers are thin delegation, so the real DatabaseManager
// over a temporary SQLite file IS the behavior being pinned: list order,
// whitelist updates, builtin delete protection, icon defaults and the
// startup seeding rule that never overwrites an edited prompt.
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-actions-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager: typeof import("../../src/helpers/database.ts").DatabaseManager = require("../../src/helpers/database.ts");

test.after(() => {
  Module._load = originalLoad;
});

function isNativeBindingUnavailable(error: unknown) {
  const message = String((error as { message?: unknown })?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

type ActionRow = import("../../src/helpers/database.js").ActionRow;
function createDb(t: import("node:test").TestContext, dir?: string): import("../../src/helpers/database.js").DatabaseManager | null {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), dir || "openhercules-actions-"));
  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("builtin catalog seeds once and list sorts by sort_order, id", (t: import("node:test").TestContext) => {
  const db = createDb(t) as import("../../src/helpers/database.js").DatabaseManager;
  if (!db) return;
  const builtins = db.getActions() as ActionRow[];
  assert.ok(builtins.length >= 3, "built-in actions are seeded");
  assert.ok(builtins.every((a: ActionRow) => a.is_builtin === 1));
  assert.ok(builtins.every((a: ActionRow) => typeof a.translation_key === "string" && a.translation_key));

  // Customs land at sort_order 0, ahead of the builtins; ties break by id.
  const custom1 = db.createAction("Zeta", "d", "p").action as ActionRow;
  const custom2 = db.createAction("Alpha", "d", "p").action as ActionRow;
  const custom3 = db.createAction("Mid", "d", "p").action as ActionRow;
  // Generate Notes also sits at sort_order 0 and holds id 1, so it wins the
  // id tie-break against the customs; remaining builtins follow by order.
  assert.deepEqual(
    db.getActions().map((a) => a.id),
    [
      builtins.find((a) => a.sort_order === 0)!.id,
      custom1.id,
      custom2.id,
      custom3.id,
      ...builtins.filter((a) => a.sort_order > 0).map((a) => a.id),
    ],
    "ORDER BY sort_order, id"
  );
  db.updateAction(custom3.id as number, { sort_order: -1 });
  assert.deepEqual(db.getActions().map((a) => a.id)[0], custom3.id, "negative sort_order sorts first");
  db.updateAction(custom3.id as number, { sort_order: 900 });
  assert.deepEqual(db.getActions().map((a) => a.id).at(-1), custom3.id);
  db.close();
});

test("create defaults icon to sparkles and keeps plain rows", (t: import("node:test").TestContext) => {
  const db = createDb(t) as import("../../src/helpers/database.js").DatabaseManager;
  if (!db) return;
  const result = db.createAction("My action", "desc", "prompt text");
  assert.equal(result.success, true);
  const action = result.action as ActionRow;
  assert.equal(action.icon, "sparkles");
  assert.equal(action.is_builtin, 0);
  assert.equal(action.translation_key, null);
  assert.equal(action.name, "My action");
  assert.equal(action.description, "desc");
  assert.equal(action.prompt, "prompt text");
  db.close();
});

test("getAction returns null for unknown ids", (t: import("node:test").TestContext) => {
  const db = createDb(t) as import("../../src/helpers/database.js").DatabaseManager;
  if (!db) return;
  assert.equal(db.getAction(987654), null);
  const action = db.createAction("A", "d", "p").action as ActionRow;
  assert.equal(db.getAction(action.id)!.id, action.id);
  db.close();
});

test("update writes each whitelisted field and ignores unknown fields", (t: import("node:test").TestContext) => {
  const db = createDb(t) as import("../../src/helpers/database.js").DatabaseManager;
  if (!db) return;
  const action = db.createAction("Before", "d", "p").action as ActionRow;

  const renamed = db.updateAction(action.id, {
    name: "After",
    description: "d2",
    prompt: "p2",
    icon: "mail",
    sort_order: 42,
    // Unknown fields must not be persisted.
    is_builtin: 1,
    translation_key: "hax",
    bogus: "x",
  } as never) as { success: boolean };
  assert.equal(renamed.success, true);
  const row = db.getAction(action.id) as ActionRow;
  assert.equal(row.name, "After");
  assert.equal(row.description, "d2");
  assert.equal(row.prompt, "p2");
  assert.equal(row.icon, "mail");
  assert.equal(row.sort_order, 42);
  assert.equal(row.is_builtin, 0, "is_builtin is not updatable");
  assert.equal(row.translation_key, null, "translation_key is not updatable");
  db.close();
});

test("empty update and unknown id report success false without changes", (t: import("node:test").TestContext) => {
  const db = createDb(t) as import("../../src/helpers/database.js").DatabaseManager;
  if (!db) return;
  const action = db.createAction("A", "d", "p").action as ActionRow;
  assert.deepEqual(db.updateAction(action.id, { bogus: "x" } as never), { success: false });
  assert.deepEqual(db.updateAction(action.id, {}), { success: false });
  const updated = db.updateAction(987654, { name: "x" });
  assert.deepEqual(updated, { success: false, action: null });
  db.close();
});

test("editing a builtin succeeds and delete rejects it", (t: import("node:test").TestContext) => {
  const db = createDb(t) as import("../../src/helpers/database.js").DatabaseManager;
  if (!db) return;
  const builtin = db.getActions()[0] as ActionRow;
  const edited = db.updateAction(builtin.id, { prompt: "user override" });
  assert.equal(edited.success, true);
  assert.equal(db.getAction(builtin.id)!.prompt, "user override");

  assert.deepEqual(db.deleteAction(builtin.id), { success: false });
  assert.ok(db.getAction(builtin.id), "builtin survives delete");

  const custom = db.createAction("Custom", "d", "p").action as ActionRow;
  assert.deepEqual(db.deleteAction(custom.id), { success: true });
  assert.equal(db.getAction(custom.id), null);
  assert.deepEqual(db.deleteAction(custom.id), { success: false });
  db.close();
});

test("reopening the database keeps custom actions and edited builtin prompts", (t: import("node:test").TestContext) => {
  {
    const db = createDb(t, "openhercules-actions-restart-") as import("../../src/helpers/database.js").DatabaseManager;
    const builtin = db.getActions().find((a: ActionRow) => a.translation_key === "notes.actions.builtin.generateNotes");
    db.updateAction(builtin!.id, { prompt: "my custom generate prompt" });
    db.createAction("Keeper", "d", "keep me");
    db.close();
  }
  const db = new DatabaseManager() as import("../../src/helpers/database.js").DatabaseManager;
  const keeper = db.getActions().find((a: ActionRow) => a.name === "Keeper");
  assert.ok(keeper, "custom action survives restart");
  const builtin = db.getActions().find((a: ActionRow) => a.translation_key === "notes.actions.builtin.generateNotes");
  assert.equal(builtin!.prompt, "my custom generate prompt", "seeding does not overwrite edits");
  db.close();
});
