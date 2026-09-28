const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { shouldRewarmOnWake }: typeof import("../../src/helpers/whisper") = require("../../src/helpers/whisper");

const base = {
  isRemote: false,
  modelName: "large",
  transcribing: false,
  rewarmInFlight: false,
};

test("re-warms a running local whisper-server after wake", () => {
  assert.equal(shouldRewarmOnWake(base), true);
});

test("skips a remote whisper-server", () => {
  assert.equal(shouldRewarmOnWake({ ...base, isRemote: true }), false);
});

test("skips when no server model is active", () => {
  assert.equal(shouldRewarmOnWake({ ...base, modelName: null }), false);
});

test("skips while a transcription is already warming the server", () => {
  assert.equal(shouldRewarmOnWake({ ...base, transcribing: true }), false);
});

test("skips while another wake re-warm is already in flight", () => {
  assert.equal(shouldRewarmOnWake({ ...base, rewarmInFlight: true }), false);
});
