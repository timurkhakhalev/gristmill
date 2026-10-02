// Issue #158: after a successful single upload, choosing "No folder" became
// "" and then Number("") = 0, which the database rejects as "Folder not
// found" — while the completion screen had already switched to the root, so
// the UI and the Open action lied about where the note lives. The tests drive
// the real component callbacks (extracted from the source, since the view has
// no standalone hook boundary) through the shared IPC update schema into a
// real temporary SQLite database, plus the failure path that must roll the
// optimistic selection back instead of leaving a false assignment.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const vm: typeof import("node:vm") = require("node:vm");
const Module = require("node:module");
import type { NoteUpdate } from "../../../../src/contracts/notes";

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-upload-folder-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager: typeof import("../../../../src/helpers/database.ts").DatabaseManager =
  require("../../../../src/helpers/database.ts");
const { updateNoteArgsSchema }: typeof import("../../../../src/contracts/notes") =
  require("../../../../src/contracts/notes.ts");

test.after(() => {
  Module._load = originalLoad;
});

function isNativeBindingUnavailable(error: unknown) {
  const message = String(error instanceof Error ? error.message : error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t: import("node:test").TestContext) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-upload-folder-"));
  try {
    const db = new DatabaseManager();
    t.after(() => db.close());
    return db;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

interface ViewCallbacks {
  handleFolderChange(val: string): void;
  selectedFolderId(): string;
  folderMoveError(): string | null;
}

// Extracts handleFolderChange and showFolderMoveFailure from the component
// source and wires them into a sandbox standing in for the closure: the
// selection/error state setters round-trip like React state, and updateNote
// parses through the shared IPC schema before reaching the real database,
// exactly like the preload does.
function buildCallbacks(
  db: NonNullable<ReturnType<typeof createDb>>,
  { failFolderWrites = false }: { failFolderWrites?: boolean } = {}
): ViewCallbacks {
  const source = fs.readFileSync(
    path.join(__dirname, "../../../../src/components/notes/UploadAudioView.tsx"),
    "utf8"
  );
  const ts: typeof import("typescript") = require(path.join(
    __dirname,
    "../../../../node_modules/typescript"
  ));
  const tree = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const initializers: Record<string, string> = {};
  const wanted = new Set(["handleFolderChange", "showFolderMoveFailure"]);
  const visit = (node: import("typescript").Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      wanted.has(node.name.getText(tree)) &&
      node.initializer
    ) {
      initializers[node.name.getText(tree)] = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const name of wanted) {
    assert.ok(initializers[name], `${name} found in UploadAudioView`);
  }

  const state: { selectedFolderId: string; folderMoveError: string | null } = {
    selectedFolderId: "",
    folderMoveError: null,
  };
  const sandbox: Record<string, unknown> = {
    noteId: 42,
    // The extracted callbacks read the closure variable directly; the getter
    // mirrors setter updates like React state would.
    get selectedFolderId() {
      return state.selectedFolderId;
    },
    setSelectedFolderId: (value: string) => {
      state.selectedFolderId = value;
    },
    setFolderMoveError: (value: string | null) => {
      state.folderMoveError = value;
    },
    t: (key: string) => key,
    window: {
      electronAPI: {
        updateNote: async (id: number, updates: NoteUpdate) => {
          const parsed = updateNoteArgsSchema.safeParse([id, updates]);
          if (!parsed.success) throw new Error("Invalid arguments for a Notes IPC call");
          if (failFolderWrites) return { success: false, error: "Folder not found" };
          const result = db.updateNote(parsed.data[0], parsed.data[1]);
          return result.success ? { success: true } : { success: false, error: result.error };
        },
      },
    },
  };
  for (const name of wanted) {
    // The initializers are TS source; transpile so vm parses plain JS.
    const expression = ts.transpileModule(`(${initializers[name]})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    sandbox[name] = vm.runInNewContext(expression, sandbox);
  }
  return {
    handleFolderChange: sandbox.handleFolderChange as ViewCallbacks["handleFolderChange"],
    selectedFolderId: () => state.selectedFolderId,
    folderMoveError: () => state.folderMoveError,
  };
}

// The move is fire-and-forget in the view; each test awaits the IPC settle.
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("choosing No folder after upload saves folder_id null in the database", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const meetingsId = db.createFolder("Meetings", spaceId).folder!.id;
  const noteId = db.saveNote("Uploaded", "", "upload", null, null, meetingsId, null).note!.id;
  const callbacks = buildCallbacks(db);

  callbacks.handleFolderChange(String(meetingsId));
  await tick();
  assert.equal(callbacks.selectedFolderId(), String(meetingsId));

  callbacks.handleFolderChange("");
  await tick();
  assert.equal(callbacks.selectedFolderId(), "");
  assert.equal(callbacks.folderMoveError(), null);
  const after = db.getNote(noteId)!;
  assert.equal(after.folder_id, null, "No folder persists as a null folder_id");
  assert.deepEqual(after.folder_ids, []);
});

test("a failed folder move reports the failure and rolls the selection back", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const meetingsId = db.createFolder("Meetings", spaceId).folder!.id;
  const noteId = db.saveNote("Uploaded", "", "upload", null, null, null, null).note!.id;
  db.updateNote(noteId, { folder_id: meetingsId });
  const callbacks = buildCallbacks(db, { failFolderWrites: true });

  // The optimistic selection flips to "" before the write; the failure must
  // restore the confirmed value instead of leaving the root lie on screen.
  callbacks.handleFolderChange("");
  await tick();
  assert.equal(callbacks.selectedFolderId(), String(meetingsId));
  assert.match(callbacks.folderMoveError()!, /folderNotFound/);
  assert.equal(db.getNote(noteId)!.folder_id, meetingsId, "the note stays in its confirmed folder");

  // A later successful change clears the stale failure message.
  const videoId = db.createFolder("Videos", spaceId).folder!.id;
  callbacks.handleFolderChange(String(videoId));
  await tick();
  assert.equal(callbacks.folderMoveError(), null, "success clears the failure message");
});

test("a rejected folder_id 0 patch never reaches the database", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const meetingsId = db.createFolder("Meetings", spaceId).folder!.id;
  const noteId = db.saveNote("Uploaded", "", "upload", null, null, meetingsId, null).note!.id;
  const callbacks = buildCallbacks(db, { failFolderWrites: true });

  // The pre-fix regression: "" through Number() reached the DB as 0 and the
  // failure was never shown. With the failure surfaced, the selection rolls
  // back to the last confirmed assignment instead of showing the root.
  callbacks.handleFolderChange("");
  await tick();
  assert.equal(db.getNote(noteId)!.folder_id, meetingsId);
  assert.equal(callbacks.selectedFolderId(), String(meetingsId));
});
