const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");
const { createRendererServer, installBrowserGlobals }: typeof import("../../../../lib/rendererTestHarness.ts") = require("../../../../lib/rendererTestHarness.ts");

let currentProfile = "";
async function fixture(t: import("node:test").TestContext) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-note-files-"));
  currentProfile = profile;
  let db: any;
  t.after(() => { db?.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  const originalLoad = Module._load;
  Module._load = function(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") return {
      app: { getPath: () => currentProfile, getAppPath: () => process.cwd(), isReady: () => false },
      BrowserWindow: { getAllWindows: () => [] },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });
  const DatabaseManager = require("../../../../../src/helpers/database.ts");
  db = new DatabaseManager();
  const { IPCHandlers } = await import("../../../../../src/helpers/ipcHandlers.ts");
  const mirror = require("../../../../../src/helpers/markdownMirror") as import("../../../../../src/helpers/markdownMirror.ts").MarkdownMirror;
  const owner = Object.create(IPCHandlers.prototype) as import("../../../../../src/helpers/ipcHandlers.ts").IPCHandlers;
  owner.databaseManager = db;
  owner._noteFilesEnabled = false;
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = { handle: (channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn); } };
  const { registerNoteFilesHandlers } = await import("../../../../../src/helpers/noteFilesIpcHandlers.ts");
  let rebuilds = 0;
  registerNoteFilesHandlers(ipc, {
    mirror, getDefaultNotesPath: () => path.join(profile, "notes"),
    setNoteFilesEnabled: (value) => { owner._noteFilesEnabled = value; },
    isNoteFilesEnabled: () => owner._noteFilesEnabled,
    rebuildMirror: (base) => { rebuilds++; owner._rebuildMirror(base); },
    showItemInFolder: () => {}, openPath: async () => "", pickFolder: async () => ({ canceled: true }),
    pickGranolaCsvFiles: async () => ({ canceled: true, filePaths: [] }),
    readFileUtf8: () => "", fileSize: () => 0,
    importNotes: () => ({ imported: 0, skipped: 0, errors: [] }),
    granolaState: { pending: null }, logError: () => {},
  });
  const { registerContainerHandlers } = await import("../../../../../src/helpers/containerIpcHandlers.ts");
  registerContainerHandlers(ipc, {
    database: db, noteFilesEnabled: () => owner._noteFilesEnabled,
    getFolderName: (id) => owner._getFolderName(id),
    mirrorWriteNote: (note) => owner._asyncMirrorWrite(note),
    mirrorEnsureFolder: (name) => mirror.ensureFolder(name),
    mirrorRenameFolder: (oldName, newName) => owner._mirrorRenameFolder(oldName, newName),
    mirrorDeleteFolderIfUnshared: (name, ids) => owner._mirrorDeleteFolderIfUnshared(name, ids),
  });
  const { createNoteFilesBridge } = await import("../../../../../src/preload/noteFilesBridge.ts");
  const bridge = createNoteFilesBridge({ invoke: async (channel, ...args) => handlers.get(channel)!(null, ...args) });
  const space = db.getSpaces()[0];
  const save = (title: string, folderId: number | null = null) => db.saveNote(title, "persisted body", "personal", null, null, folderId, space.id).note;
  return { db, profile, owner, mirror, bridge, handlers, space, save, rebuilds: () => rebuilds };
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve)); };

test("persisted settings activate real IPC/mirror once; edits, failures and restart stay consistent", async (t) => {
  const f = await fixture(t);
  const note = f.save("Root note");
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { noteFilesEnabled: "true", customDictionary: '["OpenWhispr"]' },
    window: { electronAPI: { ...f.bridge, getDictionary: async () => ["OpenWhispr"], applyDictionaryChanges: async () => ({ success: true }) } },
  });
  const vite = await createRendererServer(t);
  const { useSettingsStore: store, initializeSettings } = await vite.ssrLoadModule("/stores/settingsStore.ts") as typeof import("../../../../../src/stores/settingsStore.ts");
  assert.equal(store.getState().noteFilesEnabled, false, "persisted choice is not yet active");
  await Promise.all([initializeSettings(), initializeSettings(), initializeSettings()]);
  assert.equal(f.rebuilds(), 1);
  assert.equal(f.owner._noteFilesEnabled, true);
  assert.equal(store.getState().noteFilesEnabled, true);
  assert.match(fs.readFileSync(f.mirror.getNotePath(note.id)!, "utf8"), /persisted body/);
  const second = path.join(f.profile, "second");
  await store.getState().setNoteFilesPath(second);
  assert.equal(f.mirror.getBasePath(), second);
  assert.ok(f.mirror.getNotePath(note.id));
  const queued = f.save("Queued");
  f.owner._asyncMirrorWrite(queued);
  await store.getState().setNoteFilesEnabled(false);
  await flush();
  assert.equal(f.mirror.getNotePath(queued.id), null, "disable prevents already queued writes");
  assert.equal(storage.getItem("noteFilesEnabled"), "false");
  assert.ok(f.mirror.getNotePath(note.id), "disable retains existing files");
  await store.getState().setNoteFilesEnabled(true);
  const badPath = path.join(f.profile, "regular-file");
  fs.writeFileSync(badPath, "blocked");
  assert.equal((await store.getState().setNoteFilesPath(badPath)).success, false);
  assert.equal(f.owner._noteFilesEnabled, false);
  assert.equal(store.getState().noteFilesEnabled, false);
  assert.ok(store.getState().noteFilesError);
  assert.equal(storage.getItem("noteFilesPath"), second, "failed path never persists");
  assert.equal(storage.getItem("noteFilesEnabled"), "true", "confirmed preference retained for restart retry");
  // New renderer module and main readiness simulate restart using the same persisted profile.
  const restarted = await createRendererServer(t);
  const next = await restarted.ssrLoadModule("/stores/settingsStore.ts") as typeof import("../../../../../src/stores/settingsStore.ts");
  await next.initializeSettings();
  assert.equal(f.owner._noteFilesEnabled, true);
  assert.equal(next.useSettingsStore.getState().noteFilesEnabled, true);
  assert.ok(f.mirror.getNotePath(queued.id));
  // An unsafe descendant must fail a real rebuild rather than report success.
  const unsafe = path.join(f.profile, "unsafe");
  fs.mkdirSync(unsafe);
  fs.symlinkSync(second, path.join(unsafe, "Personal"), "dir");
  assert.equal((await next.useSettingsStore.getState().setNoteFilesPath(unsafe)).success, false);
  assert.equal(f.owner._noteFilesEnabled, false);
  assert.equal(next.useSettingsStore.getState().noteFilesEnabled, false);
});

test("real Personal folder rename/delete preserves root and surviving mirrors", async (t) => {
  const f = await fixture(t);
  const root = f.save("Root");
  const personal = f.db.getFolders(f.space.id).find((folder: { name: string }) => folder.name === "Personal") ?? f.db.createFolder("Personal", f.space.id).folder;
  const nested = f.save("Nested", personal.id);
  await f.bridge.noteFilesSetEnabled(true);
  assert.ok(f.mirror.getNotePath(root.id));
  await f.handlers.get("db-rename-folder")!(null, personal.id, "Renamed");
  await flush();
  assert.match(f.mirror.getNotePath(root.id)!, /Personal/);
  assert.match(f.mirror.getNotePath(nested.id)!, /Renamed/);
  assert.match(fs.readFileSync(f.mirror.getNotePath(nested.id)!, "utf8"), /folder: Renamed/);
  await f.handlers.get("db-delete-folder")!(null, personal.id);
  await flush();
  assert.match(f.mirror.getNotePath(root.id)!, /Personal/);
  assert.match(f.mirror.getNotePath(nested.id)!, /Personal/);
  const other = f.db.createFolder("Personal", f.space.id).folder;
  const surviving = f.save("Survivor", other.id);
  f.owner._asyncMirrorWrite(surviving);
  await flush();
  await f.handlers.get("db-delete-folder")!(null, other.id);
  await flush();
  for (const note of [root, nested, surviving]) assert.ok(f.mirror.getNotePath(note.id));
});

test("configuration edits serialize without showing a pending activation as enabled", async (t) => {
  let resolve!: (value: { success: boolean }) => void;
  const pending = new Promise<{ success: boolean }>((done) => { resolve = done; });
  const calls: unknown[][] = [];
  installBrowserGlobals(t, { window: { electronAPI: { noteFilesSetEnabled: async (...args: unknown[]) => {
    calls.push(args);
    return calls.length === 1 ? pending : { success: true };
  } } } });
  const vite = await createRendererServer(t);
  const { useSettingsStore: store } = await vite.ssrLoadModule("/stores/settingsStore.ts") as typeof import("../../../../../src/stores/settingsStore.ts");
  const enabling = store.getState().setNoteFilesEnabled(true);
  const changingPath = store.getState().setNoteFilesPath("/new/path");
  const disabling = store.getState().setNoteFilesEnabled(false);
  await Promise.resolve();
  assert.equal(store.getState().noteFilesEnabled, false);
  assert.equal(store.getState().noteFilesUpdating, true);
  assert.equal(calls.length, 1);
  resolve({ success: true });
  await Promise.all([enabling, changingPath, disabling]);
  assert.deepEqual(calls, [[true, ""], [true, "/new/path"], [false, "/new/path"]]);
  assert.equal(store.getState().noteFilesEnabled, false);
  assert.equal(store.getState().noteFilesUpdating, false);
});
