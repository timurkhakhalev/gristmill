const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");

const DRAFT_FIELDS = ["draftHfRepo", "draftFileName", "draftSizeBytes"];

// Exact expected values for the four Gemma 4 QAT entries (HF tree API).
const EXPECTED = {
  "gemma-4-31b-it-qat-q4_0": {
    size: "17.9GB",
    sizeBytes: 17651001568,
    draftHfRepo: "unsloth/gemma-4-31B-it-qat-GGUF",
    draftFileName: "mtp-gemma-4-31B-it.gguf",
    draftSizeBytes: 279955968,
  },
  "gemma-4-26b-a4b-it-qat-q4_0": {
    size: "14.7GB",
    sizeBytes: 14439363584,
    draftHfRepo: "unsloth/gemma-4-26B-A4B-it-qat-GGUF",
    draftFileName: "mtp-gemma-4-26B-A4B-it.gguf",
    draftSizeBytes: 251939328,
  },
  "gemma-4-e4b-it-qat-q4_0": {
    size: "5.2GB",
    sizeBytes: 5154941280,
    draftHfRepo: "unsloth/gemma-4-E4B-it-qat-GGUF",
    draftFileName: "mtp-gemma-4-E4B-it.gguf",
    draftSizeBytes: 59678016,
  },
  "gemma-4-e2b-it-qat-q4_0": {
    size: "3.4GB",
    sizeBytes: 3349516256,
    draftHfRepo: "unsloth/gemma-4-E2B-it-qat-GGUF",
    draftFileName: "mtp-gemma-4-E2B-it.gguf",
    draftSizeBytes: 59235648,
  },
};

type LocalProvider = { models: Array<Record<string, unknown>> };

type LocalModelEntry = { provider: LocalProvider; model: Record<string, unknown> };

function allLocalModels(): LocalModelEntry[] {
  return (modelData.localProviders as LocalProvider[]).flatMap((provider) =>
    provider.models.map((model) => ({ provider, model }))
  );
}

test("the four Gemma 4 QAT entries carry the exact drafter field triplets", () => {
  const byId = new Map(allLocalModels().map(({ model }) => [model.id as string, model]));

  for (const [id, expected] of Object.entries(EXPECTED)) {
    const model = byId.get(id) as Record<string, unknown>;
    assert.ok(model, `missing QAT entry ${id}`);
    assert.equal(model.size, expected.size, `${id} size label`);
    assert.equal(model.sizeBytes, expected.sizeBytes, `${id} main sizeBytes unchanged`);
    assert.equal(model.draftHfRepo, expected.draftHfRepo, `${id} draftHfRepo`);
    assert.equal(model.draftFileName, expected.draftFileName, `${id} draftFileName`);
    assert.equal(model.draftSizeBytes, expected.draftSizeBytes, `${id} draftSizeBytes`);
  }
});

test("no entry outside the four QAT ids gained any drafter field", () => {
  for (const { model } of allLocalModels()) {
    if ((EXPECTED as Record<string, unknown>)[model.id as string]) continue;

    for (const field of DRAFT_FIELDS) {
      assert.equal(
        (model as Record<string, unknown>)[field as string],
        undefined,
        `${model.id} unexpectedly has ${field}=${model[field]}`
      );
    }
  }
});

test("combined size label equals (main + drafter) bytes rounded to one decimal", () => {
  const byId = new Map(allLocalModels().map(({ model }) => [model.id as string, model]));

  for (const id of Object.keys(EXPECTED)) {
    const model = byId.get(id)!;
    assert.ok(typeof model.sizeBytes === "number");
    assert.ok(typeof model.draftSizeBytes === "number");
    const combined = (model.sizeBytes + model.draftSizeBytes) / 1e9;
    assert.equal(model.size, `${combined.toFixed(1)}GB`, `${id} combined size label`);
  }
});
