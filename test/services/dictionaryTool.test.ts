const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs = require("node:fs");

const os = require("node:os");

const path = require("node:path");

const Module = require("node:module");

const load = () => import("../../src/services/tools/dictionaryTool.js");

// The DB-backed persistence test loads DatabaseManager, whose init reaches
// for Electron's app.getPath; the loader patch points it at a temp dir.
const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), "dict-persist-")),
        isReady: () => false,
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

function harness(words: string[]) {
  const calls: unknown[] = [];

  return {
    calls,
    actions: {
      getDictionary: () => words,
      updateDictionary: (changes: unknown) => calls.push(changes),
    },
  };
}

test("adds new words and removes existing ones case-insensitively in one call", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr", "Parakeat"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: [" Parakeet ", "Orukeet"], remove: ["parakeat"] });

  assert.deepEqual(calls, [{ add: ["Parakeet", "Orukeet"], remove: ["parakeat"] }]);
  assert.deepEqual(result, {
    success: true,
    data: {
      added: ["Parakeet", "Orukeet"],
      removed: ["parakeat"],
      alreadyPresent: [],
      notFound: [],
    },
    displayText: 'Added "Parakeet", "Orukeet"; Removed "parakeat"',
  });
});

test("words already present are reported instead of re-added", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["openwhispr"] });

  assert.equal(calls.length, 0);
  assert.equal(result.success, false);
  assert.equal(result.displayText, 'Already in the dictionary: "openwhispr"');
});

test("removing a word that is not there fails without writing", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["Whisper"] });

  assert.equal(calls.length, 0);
  assert.deepEqual(result, {
    success: false,
    data: null,
    displayText: 'Not in the dictionary: "Whisper"',
  });
});

test("the tool is a write tool", async () => {
  const { createUpdateDictionaryTool } = await load();
  const tool = createUpdateDictionaryTool(harness([]).actions);
  assert.equal(tool.name, "update_dictionary");
  assert.equal(tool.readOnly, false);
});

// Issue #175: a correction {add:["OpenAI"], remove:["openai"]} names the same
// word twice; the add must be judged against the state after the removals so
// the corrected spelling survives instead of the word disappearing.
test("a same-word correction keeps the corrected spelling", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["openai", "Parakeat"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["OpenAI"], remove: ["openai"] });

  assert.deepEqual(calls, [{ add: ["OpenAI"], remove: ["openai"] }]);
  assert.deepEqual(result, {
    success: true,
    data: { added: ["OpenAI"], removed: ["openai"], alreadyPresent: [], notFound: [] },
    displayText: 'Added "OpenAI"; Removed "openai"',
  });
});

test("true duplicates are still reported as already present", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenAI"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["OpenAI"] });

  assert.equal(calls.length, 0);
  assert.equal(result.success, false);
  assert.equal(result.displayText, 'Already in the dictionary: "OpenAI"');
});

test("a mixed call applies the valid part and reports the missing removal", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["Orukeet"], remove: ["Parakeat"] });

  assert.deepEqual(calls, [{ add: ["Orukeet"], remove: [] }]);
  assert.deepEqual(result.data, {
    added: ["Orukeet"],
    removed: [],
    alreadyPresent: [],
    notFound: ["Parakeat"],
  });
});

test("case-variant duplicates in one add list persist once", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness([]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["OpenAI", "openai"], remove: [] });

  assert.deepEqual(calls, [{ add: ["OpenAI"], remove: [] }]);
  assert.deepEqual(result.data, {
    added: ["OpenAI"],
    removed: [],
    alreadyPresent: [],
    notFound: [],
  });
});

// Issue 175: pin the persisted half. applyDictionaryChanges removes before
// it adds inside its transaction; flipping that order would reintroduce the
// correction bug with the tool-level tests still green.
test("the persisted dictionary keeps the corrected spelling after a correction", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { DatabaseManager } = require("../../src/helpers/database.ts");
  const db = new DatabaseManager();

  const tool = createUpdateDictionaryTool({
    getDictionary: () => db.getDictionary(),
    updateDictionary: (changes: { add: string[]; remove: string[] }) => {
      db.applyDictionaryChanges(changes);
    },
  });

  assert.equal(db.applyDictionaryChanges({ add: ["openai"] }).added, 1);
  const result = await tool.execute({ add: ["OpenAI"], remove: ["openai"] });
  assert.equal(result.success, true);

  assert.deepEqual(db.getDictionary(), ["OpenAI"], "the corrected spelling replaced the old one");
  db.close();
});
