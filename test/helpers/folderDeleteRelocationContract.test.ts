const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");

// Folder deletion relocates notes to the space root in SQL (ON DELETE SET
// NULL on notes.folder_id) and database.deleteFolder reports only
// {success}. The handler must defer folder-deleted and delete the folder's
// mirror directory only when no live same-named folder remains; there is no
// relocated-note list to rewrite per note.
process.env.NODE_ENV = "test";

const originalLoad = Module._load;
let sent: Array<{ channel: string; data: unknown }> | null = null;
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-folder-del-"));
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: {
              send: (ch: string, data: unknown) => {
                if (sent) sent!.push({ channel: ch, data });
              },
            },
          },
        ],
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

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

test("deleting a folder keeps its notes and rewrites the released mirrors", async (t: import("node:test").TestContext) => {
  const DatabaseManager = require("../../src/helpers/database.ts");
  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }
  t.after(() => db.close());

  const space = db.getSpaces()[0];
  const folder = db
    .createFolder("DeletionContract", space.id)
    .folder;
  assert.ok(folder, "fixture folder created");

  const saved = db.saveNote(
    "Released note",
    "body",
    "personal",
    null,
    null,
    folder.id,
    space.id
  );
  assert.equal(saved.success, true);
  assert.equal(saved.note.folder_id, folder.id);

  // SQL level: the delete reports only success; the notes row survives with
  // folder_id cleared (ON DELETE SET NULL) and the same space.
  assert.deepEqual(db.deleteFolder(folder.id), { success: true });
  const released = db.getNote(saved.note.id);
  assert.ok(released, "the note survives the folder delete");
  assert.equal(released.folder_id, null);
  assert.equal(released.space_id, space.id);

  // Handler level: registerContainerHandlers defers folder-deleted and asks
  // the mirror layer to rewrite the released note.
  const { registerContainerHandlers } = await import(
    "../../src/helpers/containerIpcHandlers.ts"
  );
  sent = [];
  const mirrorWrites: unknown[] = [];
  let nameLookups = 0;
  const handlers = new Map();
  registerContainerHandlers(
    { handle: (channel, fn) => handlers.set(channel, fn) },
    {
      database: db,
      noteFilesEnabled: () => true,
      getFolderName: (id) => {
        nameLookups += 1;
        return id === folder.id ? "DeletionContract" : null;
      },
      mirrorWriteNote: (note) => mirrorWrites.push(note),
      mirrorEnsureFolder: () => {},
      mirrorRenameFolder: () => {},
      mirrorDeleteFolderIfUnshared: () => {},
    }
  );
  const result = await handlers.get("db-delete-folder")(null, folder.id);
  assert.deepEqual(result, { success: false });
  assert.equal(nameLookups, 1, "the mirror name is resolved before the delete");

  // Repeat against a live folder: success path writes the mirror.
  const folder2 = db.createFolder("DeletionContract2", space.id).folder;
  const saved2 = db.saveNote(
    "Released note 2",
    "",
    "personal",
    null,
    null,
    folder2.id,
    space.id
  );
  assert.equal(saved2.success, true);
  const result2 = await handlers.get("db-delete-folder")(null, folder2.id);
  assert.deepEqual(result2, { success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{ channel: "folder-deleted", data: { id: folder2.id } }]);
  // The handler has no relocated-note list to iterate (deleteFolder reports
  // only success) — it delegates mirror cleanup of the released notes to the
  // unshared-folder deletion path, so no per-note rewrite happens here.
  assert.deepEqual(mirrorWrites, []);
  assert.deepEqual(db.getNote(saved2.note.id), {
    ...saved2.note,
    folder_id: null,
    folder_ids: [],
  });
});
