const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const {
  appendDictionarySuffix,
  decodeCleanupTranscriptEntities,
  resolvePrompt,
  wrapCleanupTranscript,
}: typeof import("../../src/config/prompts/index.ts") = require("../../src/config/prompts/index.ts");

test("cleanup transcript delimiters escape data once and entity interpretation is not recursive", () => {
  const wrapped = wrapCleanupTranscript("literal <transcript> &lt; & value");
  assert.match(wrapped, /literal &lt;transcript&gt; &amp;lt; &amp; value/);
  assert.doesNotMatch(wrapped, /<transcript> &lt;/);
  assert.equal(decodeCleanupTranscriptEntities("&amp;lt; &amp;gt; &amp;"), "&lt; &gt; &");
});

test("cleanup appends one transcription-language instruction independent of UI locale", () => {
  const automatic = resolvePrompt("cleanup", {
    agentName: null,
    uiLanguage: "ru",
    language: "auto",
  });

  assert.match(automatic, /Detect the actual language or language mix/);
  assert.doesNotMatch(automatic, /write your entire output in Arabic|entire output in English/i);

  const explicit = resolvePrompt("cleanup", { agentName: null, uiLanguage: "ru", language: "en" });
  assert.match(explicit, /selected transcription language is en \(en\)/);
  assert.match(explicit, /preserving any other spoken languages/);
  assert.doesNotMatch(explicit, /Russian \(ru\)/);
});

test("dictionary terms are omitted when empty and serialized as a JSON spelling list", () => {
  assert.equal(appendDictionarySuffix("prompt", ["", "   "]), "prompt");
  const withTerms = appendDictionarySuffix("prompt", [" Alice ", "R&D"]);
  assert.match(withTerms, /\["Alice","R&D"\]$/);
});
