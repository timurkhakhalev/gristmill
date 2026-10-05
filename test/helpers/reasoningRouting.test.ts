const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/helpers/reasoningRouting.js");

test("fan-out routes provider, model and mode to the remaining scopes", async () => {
  const { buildReasoningScopePatches } = await load();

  const patches = buildReasoningScopePatches(
    {
      useCleanupModel: true,
      cleanupProvider: "corti",
      cleanupModel: "corti-s1-instant",
      cleanupCloudMode: "byok",
    },
    "providers"
  );

  const { cleanup, noteFormatting, chatIntelligence } = patches;

  assert.deepEqual(Object.keys(patches).sort(), ["chatIntelligence", "cleanup", "noteFormatting"]);
  assert.equal(cleanup.cleanupProvider, "corti");
  assert.equal(cleanup.cleanupModel, "corti-s1-instant");
  assert.equal(cleanup.cleanupMode, "providers");

  for (const scope of [noteFormatting, chatIntelligence]) {
    assert.equal(scope.provider, "corti");
    assert.equal(scope.model, "corti-s1-instant");
    assert.equal(scope.cloudMode, "byok");
    assert.equal(scope.mode, "providers");
  }
});

// A self-hosted endpoint is only reachable from a scope that carries its url
// and key; mirroring provider/model alone leaves scopes pointing at a
// "self-hosted" mode with no host behind it.
test("fan-out mirrors the endpoint url and key alongside the routing", async () => {
  const { buildReasoningScopePatches } = await load();

  const { cleanup, noteFormatting } = buildReasoningScopePatches(
    {
      cleanupProvider: "custom",
      cleanupModel: "qwen3-8b",
      cleanupCloudMode: "byok",
      cleanupCloudBaseUrl: "",
      cleanupRemoteUrl: "https://llm.lan:8080/v1",
      cleanupCustomApiKey: "lan-key",
    },
    "self-hosted"
  );

  assert.equal(cleanup.cleanupRemoteUrl, "https://llm.lan:8080/v1");
  assert.deepEqual(noteFormatting, {
    mode: "self-hosted",
    provider: "custom",
    model: "qwen3-8b",
    cloudMode: "byok",
    cloudBaseUrl: "",
    remoteUrl: "https://llm.lan:8080/v1",
    customApiKey: "lan-key",
  });
});

test("fan-out with partial settings only mirrors the provided routing fields", async () => {
  const { buildReasoningScopePatches } = await load();

  const patches = Reflect.apply(buildReasoningScopePatches, undefined, [
    { useCleanupModel: true },
    "providers",
  ]);

  const { cleanup, noteFormatting, chatIntelligence } = patches;

  assert.deepEqual(Object.keys(patches).sort(), ["chatIntelligence", "cleanup", "noteFormatting"]);
  assert.equal(Reflect.get(cleanup, "useCleanupModel"), true);
  assert.equal(cleanup.cleanupMode, "providers");
  assert.equal("cleanupProvider" in cleanup, false);

  for (const scope of [noteFormatting, chatIntelligence]) {
    assert.deepEqual(scope, { mode: "providers" });
  }
});

test("a scope inherits the fallback key when it inherits the endpoint", async () => {
  const { inheritsFallbackEndpoint } = await load();
  assert.equal(inheritsFallbackEndpoint({ mode: "self-hosted" }, "self-hosted"), true);
});

test("a scope on its own remote url keeps its own key", async () => {
  const { inheritsFallbackEndpoint } = await load();
  assert.equal(
    inheritsFallbackEndpoint(
      { mode: "self-hosted", remoteUrl: "http://host:8080/v1" },
      "self-hosted"
    ),
    false
  );
});

test("a scope on its own cloud base url keeps its own key", async () => {
  const { inheritsFallbackEndpoint } = await load();
  assert.equal(
    inheritsFallbackEndpoint(
      { mode: "providers", cloudBaseUrl: "https://api.example.com/v1" },
      "providers"
    ),
    false
  );
});

test("a differing mode never borrows the key (regression: key sent to the wrong host)", async () => {
  const { inheritsFallbackEndpoint } = await load();
  assert.equal(inheritsFallbackEndpoint({ mode: "providers" }, "self-hosted"), false);
});

test("no fallback scope means nothing to inherit", async () => {
  const { inheritsFallbackEndpoint } = await load();
  assert.equal(inheritsFallbackEndpoint({ mode: "providers" }, undefined), false);
});
