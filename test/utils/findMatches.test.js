const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => import("../../src/utils/findMatches.ts");

test("finds every non-overlapping match with offsets", async () => {
  const { matchOffsets } = await load();
  assert.deepEqual(matchOffsets("one two one", "one"), [
    [0, 3],
    [8, 11],
  ]);
});

test("matching is case-insensitive by default and case-sensitive on request", async () => {
  const { matchOffsets } = await load();
  assert.deepEqual(matchOffsets("Note note NOTE", "note"), [
    [0, 4],
    [5, 9],
    [10, 14],
  ]);
  assert.deepEqual(matchOffsets("Note note NOTE", "note", true), [[5, 9]]);
});

test("an empty query or a miss yields no offsets", async () => {
  const { matchOffsets } = await load();
  assert.deepEqual(matchOffsets("abc", ""), []);
  assert.deepEqual(matchOffsets("abc", "z"), []);
});
