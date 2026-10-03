const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/helpers/dictionaryImport.ts");

test("import accepts comma-separated words", async () => {
  const { parseDictionaryImportText } = await load();
  assert.deepEqual(parseDictionaryImportText("Alice, Bob, Carol"), ["Alice", "Bob", "Carol"]);
});

test("import accepts one word per line", async () => {
  const { parseDictionaryImportText } = await load();
  assert.deepEqual(parseDictionaryImportText("Alice\nBob\nCarol"), ["Alice", "Bob", "Carol"]);
});

test("import accepts mixed commas and new lines and skips blanks", async () => {
  const { parseDictionaryImportText } = await load();
  assert.deepEqual(parseDictionaryImportText("Alice,\n Bob\n\nCarol, "), [
    "Alice",
    "Bob",
    "Carol",
  ]);
});

// Issue #184: the exporter quotes entries a plain split would corrupt, and the
// importer parses that quoted format back. A plain paste still uses the
// comma/newline split, so ordinary words keep their convenient semantics.
test("a quoted export round-trips entries containing commas and newlines", async () => {
  const { parseDictionaryImportText, serializeDictionaryEntries } = await load();
  const words = ["Acme, Inc.", "Alice", "Bob"];
  assert.deepEqual(parseDictionaryImportText(serializeDictionaryEntries(words)), words);
});

test("a quoted export round-trips entries containing double quotes", async () => {
  const { parseDictionaryImportText, serializeDictionaryEntries } = await load();
  const words = ['He said "hi"', "Buy, sell", "Carol"];
  assert.deepEqual(parseDictionaryImportText(serializeDictionaryEntries(words)), words);
});

test("a quoted export round-trips an entry containing a newline", async () => {
  const { parseDictionaryImportText, serializeDictionaryEntries } = await load();
  const words = ["Line one\nLine two", "Second"];
  assert.deepEqual(parseDictionaryImportText(serializeDictionaryEntries(words)), words);
});

test("a plain paste with a comma in one word keeps its convenient split", async () => {
  const { parseDictionaryImportText } = await load();
  // The historical paste semantics: "Acme, Inc." pastes as two entries because
  // the paste has no quotes.
  assert.deepEqual(parseDictionaryImportText("Acme, Inc.\nBob"), ["Acme", "Inc.", "Bob"]);
});

test("quoted fields accept a comma separator and surrounding spaces", async () => {
  const { parseDictionaryImportText } = await load();
  assert.deepEqual(parseDictionaryImportText(' "Acme, Inc." , Bob\n"Carol" '), [
    "Acme, Inc.",
    "Bob",
    "Carol",
  ]);
});

test("an unbalanced quote falls back to the plain comma/newline split", async () => {
  const { parseDictionaryImportText } = await load();
  // No silent swallow: the unmatched quote is kept literally and the paste is
  // split the ordinary way.
  assert.deepEqual(parseDictionaryImportText('"Acme, Inc.\nBob'), ['"Acme', "Inc.", "Bob"]);
});

test("quoted parsing still drops blanks and trims duplicates for the caller to dedupe", async () => {
  const { parseDictionaryImportText } = await load();
  assert.deepEqual(parseDictionaryImportText('"Acme, Inc.",\n\n"Acme, Inc.",  "Bob"'), [
    "Acme, Inc.",
    "Acme, Inc.",
    "Bob",
  ]);
});

test("an empty export serializes to an empty string and imports to nothing", async () => {
  const { parseDictionaryImportText, serializeDictionaryEntries } = await load();
  assert.equal(serializeDictionaryEntries([]), "");
  assert.deepEqual(parseDictionaryImportText(serializeDictionaryEntries([])), []);
});
