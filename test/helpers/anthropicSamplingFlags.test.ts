const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");

const anthropicModels = modelData.cloudProviders.find((p: any) => p.id === "anthropic").models as Array<{ id: string; supportsTemperature: boolean }>;

test("every Anthropic model declares sampling support explicitly", () => {
  for (const model of anthropicModels) {
    assert.equal(
      typeof model.supportsTemperature,
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
    const model = anthropicModels.find((m: any) => m.id === id)!;
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
    const model = anthropicModels.find((m: any) => m.id === id)!;
    assert.equal(model.supportsTemperature, true, id);
  }
});
