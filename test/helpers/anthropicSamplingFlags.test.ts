const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const modelData: typeof import("../../src/models/modelRegistryData.json") = require("../../src/models/modelRegistryData.json");

const anthropic = modelData.cloudProviders.find((p) => p.id === "anthropic");
assert.ok(anthropic);
const anthropicModels = anthropic.models;

test("every Anthropic model declares sampling support explicitly", () => {
  for (const model of anthropicModels) {
    assert.equal(
      typeof ("supportsTemperature" in model ? model.supportsTemperature : undefined),
      "boolean",
      `${model.id} is missing supportsTemperature`
    );
  }
});

test("models from Opus 4.7 onward do not receive temperature", () => {
  for (const id of [
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
  ]) {
    const model = anthropicModels.find((m) => m.id === id)!;
    assert.ok("supportsTemperature" in model, `${id} is missing supportsTemperature`);
    assert.equal(model.supportsTemperature, false, id);
  }
});

test("legacy Anthropic families keep temperature", () => {
  for (const id of [
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
  ]) {
    const model = anthropicModels.find((m) => m.id === id)!;
    assert.ok("supportsTemperature" in model, `${id} is missing supportsTemperature`);
    assert.equal(model.supportsTemperature, true, id);
  }
});
