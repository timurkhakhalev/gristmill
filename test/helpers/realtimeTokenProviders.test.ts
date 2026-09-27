const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/helpers/realtimeTokenProviders.ts");
type TokenDeps = import("../../src/helpers/realtimeTokenProviders.ts").RealtimeTokenDependencies;
type DependencyOverrides = {
  environmentManager?: Partial<TokenDeps["environmentManager"]>;
  proxyFetch?: TokenDeps["proxyFetch"];
  postServerToken?: () => Promise<{ token: string }>;
  mintCortiToken?: TokenDeps["mintCortiToken"];
};

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const deps = (overrides: DependencyOverrides = {}) => ({
  environmentManager: {
    getOpenAIKey: () => "sk-openai",
    getTinfoilKey: () => "tk-tinfoil",
    getDeepgramKey: () => "dg-key",
    getAssemblyAIKey: () => "aai-key",
    getGeminiKey: () => "gm-key",
    ...overrides.environmentManager,
  },
  proxyFetch: overrides.proxyFetch || (async () => jsonResponse(200, { token: "aai-token" })),
  postServerToken: overrides.postServerToken || (async () => ({ token: "server-token" })),
  mintCortiToken: overrides.mintCortiToken || (async () => ({ token: "corti-token" })),
});

test("provider-less and unknown providers fail closed with the exact #1480 message", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  for (const provider of [undefined, "grok-realtime", "openai"]) {
    await assert.rejects(
      Reflect.apply(fetchRealtimeTokenForProvider, undefined, [provider, deps(), { mode: "byok" }]),
      new Error(`Unsupported realtime token provider: ${provider}`)
    );
  }
});

test("string-like provider keys use the same coercion for lookup and routing", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  assert.equal(
    await fetchRealtimeTokenForProvider(Object("openai-realtime"), deps(), { mode: "byok" }),
    "sk-openai"
  );
});

test("openai byok returns the key; dual-stream duplicates it", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  assert.equal(
    await fetchRealtimeTokenForProvider("openai-realtime", deps(), { mode: "byok" }),
    "sk-openai"
  );
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "openai-realtime",
      deps(),
      { mode: "byok" },
      { streams: 2 }
    ),
    ["sk-openai", "sk-openai"]
  );
});

test("tinfoil missing key carries the NO_API code the renderer's fallback keys on", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  const noKey = deps({ environmentManager: { getTinfoilKey: () => "" } });
  await assert.rejects(
    fetchRealtimeTokenForProvider("tinfoil-realtime", noKey, { mode: "byok" }),
    (err: any) => err.code === "NO_API"
  );
});

test("assemblyai byok mints one live token per stream", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  let mints = 0;
  const liveDeps = deps({
    proxyFetch: async () => jsonResponse(200, { token: `aai-${++mints}` }),
  });
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "assemblyai-realtime",
      liveDeps,
      { mode: "byok" },
      { streams: 2 }
    ),
    ["aai-1", "aai-2"]
  );
});

test("deepgram byok duplicates the key", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "deepgram-realtime",
      deps(),
      { mode: "byok" },
      { streams: 2 }
    ),
    ["dg-key", "dg-key"]
  );
});

test("gemini byok duplicates the raw key", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  // The raw key opens the Live socket itself and survives any number of
  // handshakes, so both streams share it.
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "gemini-realtime",
      deps(),
      { mode: "byok" },
      { streams: 2 }
    ),
    ["gm-key", "gm-key"]
  );
});

test("corti mints one token and shares it across both streams", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  let mints = 0;
  const cortiDeps = deps({ mintCortiToken: async () => ({ token: `corti-${++mints}` }) });
  assert.deepEqual(
    await fetchRealtimeTokenForProvider("corti-realtime", cortiDeps, {}, { streams: 2 }),
    ["corti-1", "corti-1"]
  );
  assert.equal(mints, 1);
});

test("missing byok keys throw configuration errors, not token errors", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  const empty = {
    getOpenAIKey: () => "",
    getDeepgramKey: () => "",
    getAssemblyAIKey: () => "",
    getGeminiKey: () => "",
  };
  for (const provider of [
    "openai-realtime",
    "deepgram-realtime",
    "assemblyai-realtime",
    "gemini-realtime",
  ] as const) {
    await assert.rejects(
      fetchRealtimeTokenForProvider(provider, deps({ environmentManager: empty }), {
        mode: "byok",
      }),
      /key configured/
    );
  }
});

test("managed modes never call the OpenWhispr token bootstrap", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  let serverCalls = 0;
  const directOnlyDeps = deps({
    postServerToken: async () => {
      serverCalls += 1;
      return { token: "must-not-be-used" };
    },
  });
  for (const provider of [
    "openai-realtime",
    "assemblyai-realtime",
    "deepgram-realtime",
    "gemini-realtime",
  ] as const) {
    await assert.rejects(
      fetchRealtimeTokenForProvider(provider, directOnlyDeps, { mode: "openwhispr" }),
      /requires a direct provider API key/
    );
  }
  assert.equal(serverCalls, 0);
});
