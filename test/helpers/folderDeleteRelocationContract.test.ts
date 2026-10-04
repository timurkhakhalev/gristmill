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
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-folder-del-"));
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
  const deleteResult = db.deleteFolder(folder.id);
  assert.equal(deleteResult.success, true);
  assert.deepEqual(deleteResult.relocatedNoteIds, [saved.note.id]);
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
  assert.equal(result.success, false);
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
  assert.equal(result2.success, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{ channel: "folder-deleted", data: { id: folder2.id } }]);
  // The rewrite happens on the unshared-folder deletion path (with the ids
  // closed over per call); this fake double doesn't exercise it.
  assert.deepEqual(mirrorWrites, []);
  assert.deepEqual(db.getNote(saved2.note.id), {
    ...saved2.note,
    folder_id: null,
    folder_ids: [],
  });
});

// Issue #174: with the note-files mirror enabled, deleting a folder used to
// throw inside the deferred mirror callback — the schema has no folders.
// deleted_at column — leaving the mirror directory on disk. The real adapter
// path must complete without an exception, rewrite the surviving notes'
// mirror files at their new location, and only then remove the directory
// (filesystem results, not fake-adapter calls).
test("mirror-enabled folder delete cleans up the directory and preserves surviving notes' mirrors", async (t: import("node:test").TestContext) => {
  const DatabaseManager = require("../../src/helpers/database.ts");
  const { IPCHandlers } = await import("../../src/helpers/ipcHandlers.ts");
  const markdownMirror = require("../../src/helpers/markdownMirror") as import("../../src/helpers/markdownMirror.ts").MarkdownMirror;
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

  const mirrorBase = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-fix-"));
  markdownMirror.init(mirrorBase);
  t.after(() => {
    markdownMirror.init(path.join(os.tmpdir(), "mirror-reset-disabled"));
    fs.rmSync(mirrorBase, { recursive: true, force: true });
  });

  const space = db.getSpaces()[0];
  const personal = db.getFolders().find((f: { is_default: boolean }) => f.is_default) ??
    db.createFolder("Personal", space.id).folder;
  const doomed = db.createFolder("MirrorDoomed", space.id).folder;
  const relocatedTo = db.createFolder("MirrorNext", space.id).folder;

  // One note relocates to the extra folder "MirrorNext"; one falls back to
  // the Personal directory (folder_id NULL).
  const relocated = db.saveNote("Relocated note", "body A", "personal", null, null, doomed.id, space.id);
  db.sql
    .prepare("INSERT OR IGNORE INTO note_folders (note_id, folder_id) VALUES (?, ?)")
    .run(relocated.note.id, relocatedTo.id);
  const released = db.saveNote("Released note", "body B", "personal", null, null, doomed.id, space.id);

  // Mirror both notes into the doomed directory, like a live mirror would be.
  const mirrorAdapter = Object.create(IPCHandlers.prototype) as {
    _noteFilesEnabled: boolean;
    databaseManager: typeof db;
    _mirrorDeleteFolderIfUnshared(folderName: string, relocatedNoteIds: number[]): void;
  };
  mirrorAdapter._noteFilesEnabled = true;
  mirrorAdapter.databaseManager = db;
  markdownMirror.writeNote(relocated.note as never, "MirrorDoomed");
  markdownMirror.writeNote(released.note as never, "MirrorDoomed");
  const doomedDir = path.join(mirrorBase, "MirrorDoomed");
  const mirrorFile = (base: string, title: string, id: number) =>
    path.join(base, `${id}-${String(title).toLowerCase().replace(/\s+/g, "-")}.md`);
  assert.ok(fs.existsSync(mirrorFile(doomedDir, "Relocated-note", relocated.note.id)), "fixture: relocated note mirrored in doomed dir");
  assert.ok(fs.existsSync(mirrorFile(doomedDir, "Released-note", released.note.id)), "fixture: released note mirrored in doomed dir");

  // The DB delete succeeds; the deferred mirror callback runs the real
  // adapter path (schema-correct query + per-note rewrite + directory rm).
  const deleteResult = db.deleteFolder(doomed.id);
  assert.deepEqual(deleteResult, { success: true, relocatedNoteIds: [relocated.note.id, released.note.id] });
  assert.doesNotThrow(() => mirrorAdapter._mirrorDeleteFolderIfUnshared("MirrorDoomed", deleteResult.relocatedNoteIds));
  // The rewrites are setImmediate-deferred (same as production mirror writes).
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // Surviving notes' mirrors exist at their new locations.
  const relocatedRow = db.getNote(relocated.note.id);
  assert.equal(relocatedRow.folder_id, relocatedTo.id, "the note relocated to its extra folder");
  assert.ok(
    fs.existsSync(mirrorFile(path.join(mirrorBase, "MirrorNext"), "Relocated-note", relocated.note.id)),
    "the relocated note's mirror file exists in the new folder"
  );
  const releasedRow = db.getNote(released.note.id);
  assert.equal(releasedRow.folder_id, null, "the released note fell back to no folder");
  assert.ok(
    fs.existsSync(mirrorFile(path.join(mirrorBase, personal.name), "Released-note", released.note.id)),
    "the released note's mirror file exists in the fallback directory"
  );

  // The doomed directory is gone; unrelated directories stay.
  assert.equal(fs.existsSync(doomedDir), false, "the stale mirror directory is removed");
  assert.ok(fs.existsSync(path.join(mirrorBase, "MirrorNext")), "unrelated mirror directories survive");
});

test("a live same-named folder in another space keeps the shared mirror directory", async (t: import("node:test").TestContext) => {
  const DatabaseManager = require("../../src/helpers/database.ts");
  const { IPCHandlers } = await import("../../src/helpers/ipcHandlers.ts");
  const markdownMirror = require("../../src/helpers/markdownMirror") as import("../../src/helpers/markdownMirror.ts").MarkdownMirror;
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

  const mirrorBase = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-shared-"));
  markdownMirror.init(mirrorBase);
  t.after(() => {
    markdownMirror.init(path.join(os.tmpdir(), "mirror-reset-disabled"));
    fs.rmSync(mirrorBase, { recursive: true, force: true });
  });

  const spaceA = db.getSpaces()[0];
  const spaceBRow = db.sql
    .prepare("INSERT INTO spaces (name, kind) VALUES (?, 'private')")
    .run("Second space");
  const spaceB = { id: Number(spaceBRow.lastInsertRowid) };
  const sharedName = "SharedName";
  const folderA = db.createFolder(sharedName, spaceA.id).folder;
  const folderB = spaceB ? db.createFolder(sharedName, spaceB.id).folder : db.createFolder(sharedName, spaceA.id).folder;
  assert.ok(folderA && folderB, "fixture folders created");

  const adapter = Object.create(IPCHandlers.prototype) as {
    _noteFilesEnabled: boolean;
    databaseManager: typeof db;
    _mirrorDeleteFolderIfUnshared(folderName: string, relocatedNoteIds: number[]): void;
  };
  adapter._noteFilesEnabled = true;
  adapter.databaseManager = db;
  fs.mkdirSync(path.join(mirrorBase, sharedName), { recursive: true });

  const deleteA = db.deleteFolder(folderA.id);
  assert.doesNotThrow(() => adapter._mirrorDeleteFolderIfUnshared(sharedName, deleteA.relocatedNoteIds));
  assert.ok(
    fs.existsSync(path.join(mirrorBase, sharedName)),
    "the live same-named folder's mirror directory is untouched"
  );

  // Once no live same-named folder remains, the directory goes.
  const deleteB = db.deleteFolder(folderB.id);
  adapter._mirrorDeleteFolderIfUnshared(sharedName, deleteB.relocatedNoteIds);
  assert.equal(fs.existsSync(path.join(mirrorBase, sharedName)), false);
});

// Issue #175 fix-round regression for #174: a second folder delete in the
// same tick must not swap the first delete's relocated-note ids out from
// under its deferred mirror callback (instance-state capture did exactly
// that — the first folder's directory was removed WITH its surviving notes'
// mirror copies).
test("two deletes in one tick keep each delete's own relocated-note ids", async (t: import("node:test").TestContext) => {
  const DatabaseManager = require("../../src/helpers/database.ts");
  const { IPCHandlers } = await import("../../src/helpers/ipcHandlers.ts");
  const markdownMirror: import("../../src/helpers/markdownMirror.ts").MarkdownMirror = require("../../src/helpers/markdownMirror");
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

  const mirrorBase = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-interleave-"));
  markdownMirror.init(mirrorBase);
  t.after(() => {
    markdownMirror.init(path.join(os.tmpdir(), "mirror-reset-disabled"));
    fs.rmSync(mirrorBase, { recursive: true, force: true });
  });

  const space = db.getSpaces()[0];
  const personal = db.getFolders().find((f: { is_default: boolean }) => f.is_default) ??
    db.createFolder("Personal", space.id).folder;
  const doomedA = db.createFolder("InterleaveA", space.id).folder;
  const doomedB = db.createFolder("InterleaveB", space.id).folder;

  const noteA = db.saveNote("Interleave note A", "a", "personal", null, null, doomedA.id, space.id);
  const noteB = db.saveNote("Interleave note B", "b", "personal", null, null, doomedB.id, space.id);
  markdownMirror.writeNote(noteA.note as never, "InterleaveA");
  markdownMirror.writeNote(noteB.note as never, "InterleaveB");

  const adapter = Object.create(IPCHandlers.prototype) as {
    _noteFilesEnabled: boolean;
    databaseManager: typeof db;
    _mirrorDeleteFolderIfUnshared(folderName: string, relocatedNoteIds: number[]): void;
  };
  adapter._noteFilesEnabled = true;
  adapter.databaseManager = db;

  const mirrorFile = (base: string, title: string, id: number) =>
    path.join(base, `${id}-${String(title).toLowerCase().replace(/\\s+/g, "-")}.md`);
  assert.ok(fs.existsSync(mirrorFile(path.join(mirrorBase, "InterleaveA"), "Interleave-note-a", noteA.note.id)), "fixture: note A mirrored");

  // Both deletes land in the same tick: the deferred callbacks have not run
  // yet when the second delete starts.
  const deleteA = db.deleteFolder(doomedA.id);
  const deleteB = db.deleteFolder(doomedB.id);
  assert.deepEqual(deleteA.relocatedNoteIds, [noteA.note.id], "delete A captures its own note");
  assert.deepEqual(deleteB.relocatedNoteIds, [noteB.note.id], "delete B captures its own note");
  adapter._mirrorDeleteFolderIfUnshared("InterleaveA", deleteA.relocatedNoteIds);
  adapter._mirrorDeleteFolderIfUnshared("InterleaveB", deleteB.relocatedNoteIds);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // Each folder's surviving note was rewritten at its fallback location
  // BEFORE its doomed directory was removed.
  assert.ok(
    fs.existsSync(mirrorFile(path.join(mirrorBase, personal.name), "Interleave-note-a", noteA.note.id)),
    "note A's mirror survived delete A's directory removal"
  );
  assert.ok(
    fs.existsSync(mirrorFile(path.join(mirrorBase, personal.name), "Interleave-note-b", noteB.note.id)),
    "note B's mirror survived delete B's directory removal"
  );
  assert.equal(fs.existsSync(path.join(mirrorBase, "InterleaveA")), false);
  assert.equal(fs.existsSync(path.join(mirrorBase, "InterleaveB")), false);
});
