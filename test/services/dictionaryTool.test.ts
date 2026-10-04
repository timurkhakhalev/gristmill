const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/services/tools/dictionaryTool.js");

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
