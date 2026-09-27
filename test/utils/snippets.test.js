const test = require("node:test");
const assert = require("node:assert/strict");

const { getDictionaryHintWords } = require("../../src/utils/snippets.ts");

test("getDictionaryHintWords returns empty list on nullish, empty, or partial settings", () => {
  assert.deepEqual(getDictionaryHintWords(null), []);
  assert.deepEqual(getDictionaryHintWords(undefined), []);
  assert.deepEqual(getDictionaryHintWords({}), []);
  assert.deepEqual(getDictionaryHintWords({ customDictionary: null }), []);
  assert.deepEqual(getDictionaryHintWords({ snippets: null }), []);
  assert.deepEqual(getDictionaryHintWords({ customDictionary: null, snippets: null }), []);
});

test("getDictionaryHintWords preserves customDictionary when snippets are absent or empty", () => {
  const customDictionary = ["OpenWhispr", "Supabase"];
  const result = getDictionaryHintWords({ customDictionary });
  assert.deepEqual(result, ["OpenWhispr", "Supabase"]);
  // Must return a fresh array, not the input reference
  assert.notEqual(result, customDictionary);

  const emptySnippetsResult = getDictionaryHintWords({ customDictionary, snippets: [] });
  assert.deepEqual(emptySnippetsResult, ["OpenWhispr", "Supabase"]);
  assert.notEqual(emptySnippetsResult, customDictionary);
});

test("getDictionaryHintWords extracts triggers when customDictionary is absent or empty", () => {
  const snippets = [
    { trigger: "my cal", replacement: "cal.com/me" },
    { trigger: "zoom link", replacement: "zoom.us/j/123" },
  ];
  assert.deepEqual(getDictionaryHintWords({ snippets }), ["my cal", "zoom link"]);
  assert.deepEqual(getDictionaryHintWords({ customDictionary: [], snippets }), [
    "my cal",
    "zoom link",
  ]);
});

test("getDictionaryHintWords combines dictionary words and snippet triggers safely", () => {
  const settings = {
    customDictionary: ["OpenWhispr", "Supabase"],
    snippets: [
      { trigger: "my cal", replacement: "cal.com/me" },
      { trigger: "zoom link", replacement: "zoom.us/j/123" },
    ],
  };
  assert.deepEqual(getDictionaryHintWords(settings), [
    "OpenWhispr",
    "Supabase",
    "my cal",
    "zoom link",
  ]);
});
