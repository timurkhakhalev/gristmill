const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

// The real bundled preload talks to a Map of real registered Notes handlers
// over a temporary SQLite database. Main-side event sends are dispatched back
// into the preload-registered listeners, closing the loop like Electron does,
// without exposing any event object to renderer callbacks.
let activeHandlers = null;
let dispatchSend = null;
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-notes-bridge-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel, listener) => {
          if (!activeHandlers) activeHandlers = new Map();
          activeHandlers.set(channel, listener);
        },
      },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: {
              send: (channel, data) => {
                if (dispatchSend) dispatchSend(channel, data);
              },
            },
          },
        ],
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.ts");

test.after(() => {
  Module._load = originalLoad;
});

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function loadBundledPreload(invoke) {
  // A channel can have several listeners (Electron supports that); keep arrays.
  const listeners = new Map();
  let api;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    require(name) {
      assert.equal(name, "electron", "the bundled preload must only require electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke,
          send() {},
          on(channel, listener) {
            const list = listeners.get(channel) || [];
            list.push(listener);
            listeners.set(channel, list);
          },
          removeListener(channel, listener) {
            const list = listeners.get(channel) || [];
            const index = list.indexOf(listener);
            if (index !== -1) list.splice(index, 1);
          },
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  return { api, listeners };
}

async function createFixture(t) {
  activeHandlers = new Map();
  dispatchSend = null;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-notes-bridge-"));
  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
  t.after(() => db.close());

  const { registerNotesHandlers } = await import("../../src/helpers/notesIpcHandlers.ts");
  registerNotesHandlers(
    { handle: (channel, listener) => activeHandlers.set(channel, listener) },
    {
      saveNote: (...args) => db.saveNote(...args),
      getNote: (id) => db.getNote(id),
      getNotes: (...args) => db.getNotes(...args),
      getNotesForSpace: (...args) => db.getNotesForSpace(...args),
      updateNote: (...args) => db.updateNote(...args),
      deleteNoteInternal: (id) => {
        const result = db.deleteNote(id);
        if (result?.success) {
          setImmediate(() => {
            if (dispatchSend) dispatchSend("note-deleted", { id });
          });
        }
        return result;
      },
      searchNotes: (...args) => db.searchNotes(...args),
      asyncMirrorWrite: () => {},
      tryAutoLabelOneOnOne: () => {},
      refreshMeetingSpeakerConfigFromNote: () => {},
    }
  );

  const handlersSnapshot = new Map(activeHandlers);
  const invoke = async (channel, ...args) => {
    const handler = handlersSnapshot.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler(null, ...args);
  };
  const { api, listeners } = loadBundledPreload(invoke);
  // Close the event loop: main-side sends dispatch into the listeners the
  // preload registered, exactly like Electron would.
  dispatchSend = (channel, data) => {
    for (const listener of listeners.get(channel) || []) {
      listener(null, data);
    }
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { db, api, listeners, flush };
}

test("the full bundled preload chain round-trips a note", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, flush } = ctx;

  const saved = await api.saveNote("Bridge", "Body", "personal", null, null, null, null);
  assert.equal(saved.success, true);
  assert.equal(saved.note.title, "Bridge");

  assert.deepEqual(await api.getNote(saved.note.id), saved.note);
  assert.equal(await api.getNote(987654), null);

  const updated = await api.updateNote(saved.note.id, { title: "Bridge2" });
  assert.equal(updated.success, true);
  assert.equal(updated.note.title, "Bridge2");

  const listed = await api.getNotes(null, 100, null, null);
  assert.ok(listed.some((n) => n.id === saved.note.id));

  const spaceId = saved.note.space_id;
  const spaceNotes = await api.getSpaceNotes(spaceId, 50);
  assert.ok(spaceNotes.some((n) => n.id === saved.note.id));

  const found = await api.searchNotes("Bridge2", 50, null, null);
  assert.ok(found.some((n) => n.id === saved.note.id));
  assert.equal((await api.searchNotes("", 50, null, null)).length, 0);

  const deleted = await api.deleteNote(saved.note.id);
  assert.equal(deleted.success, true);
  await flush();
  assert.equal(await api.getNote(saved.note.id), null);
});

test("wrong arguments reject through the bridge before the DB runs", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api } = ctx;

  await assert.rejects(() => api.getNote("nope"));
  await assert.rejects(() => api.updateNote(1, { title: 42 }));
  await assert.rejects(() => api.saveNote(1, "x"));
});

test("independent subscriptions receive events and unsubscribe cleanly", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, flush } = ctx;

  const added = [];
  const addedToo = [];
  const unsubA = api.onNoteAdded((note) => added.push(note));
  const unsubB = api.onNoteAdded((note) => addedToo.push(note));

  const saved = await api.saveNote("Sub", "");
  await flush();

  assert.equal(added.length, 1);
  assert.equal(addedToo.length, 1);
  assert.equal(added[0].id, saved.note.id);

  unsubA();
  const second = await api.saveNote("Sub2", "");
  await flush();

  assert.equal(added.length, 1, "unsubscribed listener is not called again");
  assert.equal(addedToo.length, 2);
  assert.equal(addedToo[1].id, second.note.id);
  unsubB();
});

test("malformed events are dropped; the next valid one is delivered", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, flush } = ctx;

  const received = [];
  api.onNoteAdded((note) => received.push(note));

  // Simulate a main-side producer emitting a malformed payload.
  const { sendNoteAdded } = await import("../../src/helpers/notesEvents.ts");
  sendNoteAdded({ id: 1, broken: true });
  await flush();
  assert.deepEqual(received, [], "malformed payloads never reach the renderer");

  const saved = await api.saveNote("Valid", "");
  await flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].id, saved.note.id);
});

test("deleted notes are not resurrectable and emit note-deleted once", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, flush } = ctx;

  const deletions = [];
  const unsub = api.onNoteDeleted((payload) => deletions.push(payload));
  const saved = await api.saveNote("Gone", "");
  assert.equal((await api.deleteNote(saved.note.id)).success, true);
  await flush();
  assert.equal(deletions.length, 1);
  assert.equal(deletions[0].id, saved.note.id);

  assert.equal((await api.deleteNote(saved.note.id)).success, false);
  await flush();
  assert.equal(deletions.length, 1);
  unsub();
});
