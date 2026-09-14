const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeStoredSpeakerCount } = require("../../src/helpers/speakerCount");
const { MAX_SPEAKER_COUNT } = require("../../src/constants/speakerDetection.json");

test("keeps a usable stored count", () => {
  assert.equal(normalizeStoredSpeakerCount(1), 1);
  assert.equal(normalizeStoredSpeakerCount(3), 3);
  assert.equal(normalizeStoredSpeakerCount(MAX_SPEAKER_COUNT), MAX_SPEAKER_COUNT);
});

test("clamps above the supported maximum", () => {
  assert.equal(normalizeStoredSpeakerCount(MAX_SPEAKER_COUNT + 5), MAX_SPEAKER_COUNT);
});

test("rejects values the cloud can persist but the app cannot use", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, null, undefined, "", {}, []]) {
    assert.equal(
      normalizeStoredSpeakerCount(value),
      null,
      `expected ${JSON.stringify(value)} to normalize to null`
    );
  }
});

// Number() coercion is part of the stored-data contract: JSON columns hand back
// strings and booleans, and inputs like [2] arrive from sloppy persisted
// shapes. Pin the exact outcomes so a rewrite to typeof checks would be
// caught, and note what Number() cannot digest.
test("Number() coercion of string, boolean and single-element array inputs", () => {
  assert.equal(normalizeStoredSpeakerCount("2"), 2);
  assert.equal(normalizeStoredSpeakerCount(" 2 "), 2);
  assert.equal(normalizeStoredSpeakerCount("8"), MAX_SPEAKER_COUNT);
  assert.equal(normalizeStoredSpeakerCount("9"), MAX_SPEAKER_COUNT); // coerced then clamped
  assert.equal(normalizeStoredSpeakerCount("abc"), null);
  assert.equal(normalizeStoredSpeakerCount(true), 1);
  assert.equal(normalizeStoredSpeakerCount(false), null);
  assert.equal(normalizeStoredSpeakerCount([2]), 2);
  assert.equal(normalizeStoredSpeakerCount(["2"]), 2);
  assert.equal(normalizeStoredSpeakerCount([0]), null);
  assert.equal(normalizeStoredSpeakerCount([2, 3]), null); // Number([2,3]) is NaN
});

// A plain object with valueOf() coerces the same way it always has; keep the
// current behavior visible rather than silently reclassifying it later.
test("object with valueOf still coerces through Number()", () => {
  assert.equal(normalizeStoredSpeakerCount({ valueOf: () => 2 }), 2);
  assert.equal(normalizeStoredSpeakerCount({ valueOf: () => 0 }), null);
});

// Stored data crossing the JS/storage boundary can legitimately contain a
// symbol-like value only via deliberate abuse; the function keeps throwing
// (Number() behavior) instead of degrading it to null.
test("symbol input still throws TypeError", () => {
  assert.throws(() => normalizeStoredSpeakerCount(Symbol("x")), TypeError);
});
