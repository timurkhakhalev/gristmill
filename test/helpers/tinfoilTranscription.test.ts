const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const Module = require("node:module");

const transcriptionModulePath = require.resolve("../../src/helpers/tinfoilTranscription.ts");

const originalLoad = Module._load;

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function loadTranscription(fetchImpl: unknown) {
  delete require.cache[transcriptionModulePath];

  Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
    if (request === "./tinfoilSecureClient" || request === "./tinfoilSecureClient.js") {
      return { tinfoilSecureFetch: fetchImpl };
    }

    if (request === "./debugLogger") {
      return { debug() {} };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(transcriptionModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function okResponse(text: string) {
  return { ok: true, status: 200, json: async () => ({ text }) };
}

const AUDIO = {
  audioBuffer: Buffer.from("fake audio"),
  fileName: "audio.webm",
  contentType: "audio/webm",
  apiKey: "tk_test",
};

test("posts to the attested transcriptions path with the registry's batch model", async () => {
  const calls: { path: string; init: FetchInit }[] = [];

  const { transcribeWithTinfoil } = loadTranscription(async (path: string, init: FetchInit) => {
    calls.push({ path, init });

    return okResponse("hello world");
  });

  const result = await transcribeWithTinfoil({ ...AUDIO, language: "en" });

  assert.equal(result.text, "hello world");
  assert.equal(result.model, "voxtral-small-24b");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/audio/transcriptions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer tk_test");

  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), "voxtral-small-24b");
  assert.equal(form.get("language"), "en");
});

test("never sends the realtime model, which only serves /v1/realtime", async () => {
  let sentModel;

  const { transcribeWithTinfoil } = loadTranscription(async (_path: string, init: FetchInit) => {
    assert.ok(init.body instanceof FormData);
    sentModel = init.body.get("model");

    return okResponse("x");
  });

  await transcribeWithTinfoil(AUDIO);

  assert.notEqual(sentModel, "voxtral-mini-4b-realtime");
});

test("omits language when auto-detecting", async () => {
  let form: FormData | undefined;

  const { transcribeWithTinfoil } = loadTranscription(async (_path: string, init: FetchInit) => {
    assert.ok(init.body instanceof FormData);
    form = init.body;

    return okResponse("x");
  });

  await transcribeWithTinfoil({ ...AUDIO, language: "auto" });

  const sentForm = () => form;
  assert.equal(sentForm()?.get("language"), null);
});

test("a missing key fails before any request is made", async () => {
  let called = false;

  const { transcribeWithTinfoil } = loadTranscription(async () => {
    called = true;

    return okResponse("x");
  });

  await assert.rejects(() => transcribeWithTinfoil({ ...AUDIO, apiKey: "  " }), {
    code: "API_KEY_MISSING",
  });
  assert.equal(called, false);
});

test("401 surfaces as INVALID_KEY", async () => {
  const { transcribeWithTinfoil } = loadTranscription(async () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
  }));

  await assert.rejects(() => transcribeWithTinfoil(AUDIO), { code: "INVALID_KEY" });
});

test("other failures carry the status and body", async () => {
  const { transcribeWithTinfoil } = loadTranscription(async () => ({
    ok: false,
    status: 404,
    text: async () => "The model does not exist.",
  }));

  await assert.rejects(() => transcribeWithTinfoil(AUDIO), {
    message: "Tinfoil API Error: 404 The model does not exist.",
  });
});

test("429 surfaces as PROVIDER_RATE_LIMITED, 5xx as SERVER_ERROR", async () => {
  const rateLimited = loadTranscription(async () => ({
    ok: false,
    status: 429,
    text: async () => "slow down",
  }));

  await assert.rejects(() => rateLimited.transcribeWithTinfoil(AUDIO), {
    code: "PROVIDER_RATE_LIMITED",
  });

  const serverError = loadTranscription(async () => ({
    ok: false,
    status: 503,
    text: async () => "unavailable",
  }));

  await assert.rejects(() => serverError.transcribeWithTinfoil(AUDIO), { code: "SERVER_ERROR" });
});

test("forwards the dictionary prompt, and omits it when blank", async () => {
  let form: FormData | undefined;

  const { transcribeWithTinfoil } = loadTranscription(async (_path: string, init: FetchInit) => {
    assert.ok(init.body instanceof FormData);
    form = init.body;

    return okResponse("x");
  });

  await transcribeWithTinfoil({ ...AUDIO, prompt: "Qdrant, Voxtral" });
  const sentForm = () => form;
  assert.equal(sentForm()?.get("prompt"), "Qdrant, Voxtral");

  await transcribeWithTinfoil({ ...AUDIO, prompt: "   " });
  assert.equal(sentForm()?.get("prompt"), null);
});
