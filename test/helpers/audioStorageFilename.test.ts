const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  installElectronStub,
}: typeof import("./harness/electronStub.ts") = require("./harness/electronStub.ts");

installElectronStub();

const AudioStorageManager: typeof import("../../src/helpers/audioStorage.ts").AudioStorageManager = require("../../src/helpers/audioStorage.ts");

// Saved audio is named after the dictation's wall clock, so the name has to be
// read in the user's zone. transcriptions.timestamp comes in two shapes: the
// bare SQLite CURRENT_TIMESTAMP form, which is UTC with no designator, and the
// zoned form saveTranscription now writes. Only the second is unambiguous to
// `new Date`, so the first has to be pinned to UTC before it is read.
function filenameFor(timestamp: unknown) {
  return Object.create(AudioStorageManager.prototype)._buildFilename(42, timestamp);
}

test("names saved audio in local time whether or not the timestamp carries a zone", (t: import("node:test").TestContext) => {
  const original = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  t.after(() => {
    process.env.TZ = original;
  });

  // 12:00 UTC is 05:00 in Los Angeles. Both spellings name the same instant, so
  // both must produce the same name.
  assert.equal(filenameFor("2026-09-10 12:00:00.000Z"), "Gristmill-2026-09-10-05-00-00-42.webm");
  assert.equal(filenameFor("2026-09-10 12:00:00"), "Gristmill-2026-09-10-05-00-00-42.webm");
});

test("falls back to the bare name when the timestamp is unusable", () => {
  assert.equal(filenameFor(null), "Gristmill-42.webm");
  assert.equal(filenameFor("not a date"), "Gristmill-42.webm");
});
