// The typed transcribe-audio-file-byok handler after the cutover: fake
// transports and provider clients over a real temp file, real route resolver
// and the real shared cancel registry. Pins payload validation before any
// work, the auth/route dialects, provider size caps, the diarization
// projection, malformed provider responses and the hard-cancel contract.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let registerRemoteTranscriptionHandler;
let createUploadCancelRegistry;

test.before(async () => {
  ({ registerRemoteTranscriptionHandler } =
    await import("../../src/helpers/remoteTranscriptionIpcHandler.ts"));
  ({ createUploadCancelRegistry } = await import("../../src/helpers/uploadCancelRegistry.ts"));
});

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-byok-typed-")));
const audioFile = path.join(tmpRoot, "audio.wav");
fs.writeFileSync(audioFile, Buffer.alloc(2048));

function makeTransport({ statusCode = 200, data = { text: "transcribed" } } = {}) {
  const calls = [];
  return {
    calls,
    postMultipart: async (url, body, boundary, headers, options) => {
      calls.push({ url: String(url), body, boundary, headers, options });
      return { statusCode, data };
    },
    postRawAudioFile: async (url, filePath, contentType, apiKey, options) => {
      calls.push({ url: String(url), filePath, contentType, apiKey, options });
      return { statusCode, data };
    },
  };
}

function baseDeps(overrides = {}) {
  const transport = overrides.transport || makeTransport();
  const registry = overrides.uploadCancelRegistry || createUploadCancelRegistry();
  const calls = {
    reads: [],
    corti: [],
    tinfoil: [],
    gemini: [],
    warns: [],
    errors: [],
  };
  const deps = {
    resolveAllowedAudioPath: (filePath) => {
      try {
        const real = fs.realpathSync(path.resolve(filePath));
        return real.startsWith(tmpRoot + path.sep) ? real : null;
      } catch {
        return null;
      }
    },
    readFile: (filePath) => {
      calls.reads.push(filePath);
      return fs.readFileSync(filePath);
    },
    fileSize: (filePath) => fs.statSync(filePath).size,
    providerBaseUrls: () => [],
    postMultipart: transport.postMultipart,
    postRawAudioFile: transport.postRawAudioFile,
    transcribeWithTinfoil: async (args) => {
      calls.tinfoil.push(args);
      return { text: "tinfoil text" };
    },
    transcribeWithGemini: async (args) => {
      calls.gemini.push(args);
      return { text: "gemini text" };
    },
    transcribeWithCorti: async (args) => {
      calls.corti.push(args);
      return { text: "corti text" };
    },
    getCortiClientId: () => "corti-id",
    getCortiClientSecret: () => "corti-secret",
    getTinfoilKey: () => "tinfoil-key",
    getGeminiKey: () => "gemini-key",
    uploadCancelRegistry: registry,
    logDebug: () => {},
    logWarn: (message, data) => calls.warns.push({ message, data }),
    logError: (message, data) => calls.errors.push({ message, data }),
    ...overrides.deps,
  };
  return { deps, calls, transport, registry };
}

test("Deepgram sends the complete file with its own auth and maps timed speakers", async () => {
  const transport = makeTransport({
    data: {
      results: {
        channels: [{ alternatives: [{ transcript: "Привет. Ответ." }] }],
        utterances: [
          { start: 0.2, end: 0.8, transcript: "Привет.", speaker: 0 },
          { start: 1, end: 1.6, transcript: "Ответ.", speaker: 1 },
        ],
      },
    },
  });
  const { call, calls } = setup({ transport });
  const result = await call({
    filePath: audioFile,
    apiKey: "dg-secret",
    provider: "deepgram",
    model: "nova-3",
    diarize: true,
    language: "ru",
    requestId: "deepgram-1",
  });
  assert.equal(result.success, true);
  assert.equal(result.diarized, true);
  assert.deepEqual(
    result.segments.map((s) => s.speaker),
    ["Speaker 1", "Speaker 2"]
  );
  assert.match(result.text, /Привет/);
  assert.equal(transport.calls[0].filePath, audioFile);
  assert.equal(transport.calls[0].apiKey, "dg-secret");
  assert.equal(transport.calls[0].contentType, "audio/wav");
  assert.equal(transport.calls[0].options.signal instanceof AbortSignal, true);
  assert.equal(calls.reads.length, 0, "the upload streams from disk");
  const url = new URL(transport.calls[0].url);
  assert.equal(url.origin, "https://api.deepgram.com");
  assert.equal(url.pathname, "/v1/listen");
  assert.equal(url.searchParams.get("model"), "nova-3");
  assert.equal(url.searchParams.get("diarize_model"), "latest");
  assert.equal(url.searchParams.get("language"), "ru");
  assert.equal(url.searchParams.has("multichannel"), false);
});

test("Deepgram fails closed when speaker data is missing, key is absent, or size exceeds its limit", async () => {
  const transport = makeTransport({
    data: { results: { channels: [{ alternatives: [{ transcript: "Hello" }] }] } },
  });
  const { call } = setup({ transport });
  const input = { filePath: audioFile, provider: "deepgram", apiKey: "dg-secret", diarize: true };
  assert.equal((await call(input)).code, "DEEPGRAM_DIARIZATION_MISSING");
  assert.equal((await call({ ...input, apiKey: "" })).success, false);
  const { call: limited, transport: limitedTransport } = setup({
    deps: { fileSize: () => 2 * 1024 * 1024 * 1024 + 1 },
  });
  assert.match((await limited(input)).error, /2048 MB/);
  assert.equal(limitedTransport.calls.length, 0);
});

test("Deepgram handles plain transcripts and provider errors without losing the selected route", async () => {
  const plain = setup({
    transport: makeTransport({
      data: { results: { channels: [{ alternatives: [{ transcript: "Plain text" }] }] } },
    }),
  });
  const input = { filePath: audioFile, provider: "deepgram", apiKey: "dg-secret" };
  assert.deepEqual(await plain.call(input), { success: true, text: "Plain text" });
  assert.equal(new URL(plain.transport.calls[0].url).searchParams.get("detect_language"), "true");

  const invalid = setup({ transport: makeTransport({ statusCode: 401, data: {} }) });
  assert.match((await invalid.call(input)).error, /Deepgram API key/);

  const limited = setup({ transport: makeTransport({ statusCode: 413, data: {} }) });
  assert.match((await limited.call(input)).error, /audio size/);

  const busy = setup({ transport: makeTransport({ statusCode: 429, data: {} }) });
  assert.match((await busy.call(input)).error, /rate limit/);

  const malformed = setup({ transport: makeTransport({ data: { results: {} } }) });
  assert.equal((await malformed.call(input)).code, "DEEPGRAM_INVALID_RESPONSE");
});

function setup(overrides = {}) {
  const { deps, calls, transport, registry } = baseDeps(overrides);
  const handlers = new Map();
  registerRemoteTranscriptionHandler({ handle: (channel, fn) => handlers.set(channel, fn) }, deps);
  const call = (payload) => handlers.get("transcribe-audio-file-byok")(null, payload);
  return { call, calls, transport, registry, handlers };
}

test("happy path: Bearer auth, model field, signal handed to the transport", async () => {
  const { call, calls, transport } = setup();
  const result = await call({
    filePath: audioFile,
    apiKey: "sk-openai",
    model: "gpt-transcribe",
    provider: "openai",
    language: "",
    transcriptionMode: "providers",
    requestId: "req-1",
  });
  assert.equal(result.success, true);
  assert.equal(result.text, "transcribed");
  assert.match(transport.calls[0].url, /api\.openai\.com/);
  assert.equal(transport.calls[0].headers.Authorization, "Bearer sk-openai");
  assert.match(transport.calls[0].body.toString(), /name="model"[\s\S]*?gpt-transcribe/);
  assert.ok(transport.calls[0].options.signal instanceof AbortSignal);
  assert.equal(transport.calls[0].options.signal.aborted, false);
  assert.equal(calls.reads.length, 1, "file read exactly once");
});

test("mistral sends x-api-key; azure custom sends api-key; neither leaks Bearer", async () => {
  const mistral = setup();
  await mistral.call({
    filePath: audioFile,
    apiKey: "mk",
    provider: "mistral",
    language: "",
    transcriptionMode: "providers",
  });
  assert.match(mistral.transport.calls[0].url, /api\.mistral\.ai/);
  assert.equal(mistral.transport.calls[0].headers["x-api-key"], "mk");
  assert.equal(mistral.transport.calls[0].headers.Authorization, undefined);

  const azure = setup();
  await azure.call({
    filePath: audioFile,
    apiKey: "ak",
    provider: "custom",
    baseUrl: "https://myres.openai.azure.com",
    model: "my-deployment",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(azure.transport.calls[0].headers["api-key"], "ak");
  assert.equal(azure.transport.calls[0].headers.Authorization, undefined);
  assert.match(
    azure.transport.calls[0].url,
    /myres\.openai\.azure\.com\/openai\/deployments\/my-deployment/
  );
});

test("a misconfigured custom endpoint fails closed before any read or request", async () => {
  const { call, calls, transport } = setup();
  const result = await call({
    filePath: audioFile,
    apiKey: "ck",
    provider: "custom",
    baseUrl: "https://api.openai.com/v1",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.equal(calls.reads.length, 0);
  assert.equal(transport.calls.length, 0);
});

test("self-hosted is exempt from the third-party size cap; byok caps report the applied limit", async () => {
  const bigFile = path.join(tmpRoot, "big.wav");
  fs.writeFileSync(bigFile, Buffer.alloc(26 * 1024 * 1024, 1));

  const selfHosted = setup();
  const ok = await selfHosted.call({
    filePath: bigFile,
    provider: "custom",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.example.com/v1",
    remoteTranscriptionModel: "whisper-1",
    language: "",
  });
  assert.equal(ok.success, true);
  assert.deepEqual(selfHosted.transport.calls[0].headers, {}, "auth scheme none");

  const byok = setup();
  const capped = await byok.call({
    filePath: bigFile,
    apiKey: "sk",
    provider: "openai",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(capped.success, false);
  assert.match(capped.error, /25 MB/);
  assert.equal(byok.transport.calls.length, 0);

  const geminiCapped = setup();
  const gemini = await geminiCapped.call({
    filePath: bigFile,
    apiKey: "gk",
    provider: "gemini",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(gemini.success, false);
  assert.match(gemini.error, /14 MB/);
  assert.equal(geminiCapped.calls.gemini.length, 0);
});

test("proxied providers receive the signal: corti, tinfoil, gemini", async () => {
  const corti = setup();
  await corti.call({
    filePath: audioFile,
    provider: "corti",
    language: "",
    environment: "eu",
    tenant: "acme",
    transcriptionMode: "providers",
    requestId: "corti-req",
  });
  assert.equal(corti.calls.corti.length, 1);
  assert.equal(corti.calls.corti[0].environment, "eu");
  assert.equal(corti.calls.corti[0].tenant, "acme");
  assert.equal(corti.calls.corti[0].language, "en", "corti needs a concrete language");
  assert.ok(corti.calls.corti[0].signal instanceof AbortSignal);

  const tinfoil = setup();
  await tinfoil.call({
    filePath: audioFile,
    provider: "tinfoil",
    language: "de",
    transcriptionMode: "providers",
    requestId: "tinfoil-req",
  });
  assert.equal(tinfoil.calls.tinfoil[0].signal instanceof AbortSignal, true);
  assert.equal(tinfoil.calls.tinfoil[0].apiKey, "tinfoil-key");

  const gemini = setup();
  await gemini.call({
    filePath: audioFile,
    apiKey: "gk",
    provider: "gemini",
    language: "de",
    transcriptionMode: "providers",
    requestId: "gemini-req",
  });
  assert.equal(gemini.calls.gemini[0].signal instanceof AbortSignal, true);
  assert.equal(gemini.calls.gemini[0].apiKey, "gk");
});

test("openai diarization rides the route and projects diarized_json speaker segments", async () => {
  const { call, transport } = setup({
    transport: makeTransport({
      data: {
        text: "ignored",
        segments: [
          { speaker: "A", text: "hello", start: 0.5, end: 2 },
          { speaker: "", text: "world", start: 2, end: 3 },
        ],
      },
    }),
  });
  const result = await call({
    filePath: audioFile,
    apiKey: "sk",
    provider: "openai",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.equal(result.diarized, true);
  assert.deepEqual(result.segments, [
    { speaker: "A", text: "hello", start: 0.5, end: 2 },
    { speaker: "Speaker ?", text: "world", start: 2, end: 3 },
  ]);
  assert.match(result.text, /\[A\] 0:00 - 0:02\nhello/);
  const body = transport.calls[0].body.toString();
  assert.match(body, /gpt-4o-transcribe-diarize/);
  assert.match(body, /diarized_json/);
});

test("mistral speakers payload projects ids with a fallback label", async () => {
  const { call } = setup({
    transport: makeTransport({
      data: {
        text: "ignored",
        speakers: [
          { id: "S1", speaker: 1, text: "hi", start: 0, end: 1 },
          { id: "", speaker: 2, text: "yo", start: 1, end: 2 },
        ],
      },
    }),
  });
  const result = await call({
    filePath: audioFile,
    apiKey: "mk",
    provider: "mistral",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.deepEqual(
    result.segments.map((s) => s.speaker),
    ["S1", "Speaker 2"]
  );
});

test("timestamps request fields and verbose segment mapping stay per provider", async () => {
  const whisper1 = setup({
    transport: makeTransport({
      data: { text: "t", segments: [{ text: " hello ", start: -1, end: 4 }] },
    }),
  });
  const result = await whisper1.call({
    filePath: audioFile,
    apiKey: "sk",
    provider: "openai",
    model: "whisper-1",
    timestamps: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.match(whisper1.transport.calls[0].body.toString(), /verbose_json/);
  assert.deepEqual(result.segments, [{ text: "hello", start: 0, end: 4 }]);

  // A model that rejects verbose_json keeps the plain-text request untouched.
  const gpt = setup();
  await gpt.call({
    filePath: audioFile,
    apiKey: "sk",
    provider: "openai",
    model: "gpt-transcribe",
    timestamps: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.doesNotMatch(gpt.transport.calls[0].body.toString(), /verbose_json/);
});

test("HTTP failure dialects: 401, 429, embedded provider error, non-JSON server error", async () => {
  const unauthorized = setup({ transport: makeTransport({ statusCode: 401, data: {} }) });
  assert.deepEqual(
    await unauthorized.call({
      filePath: audioFile,
      apiKey: "bad",
      provider: "openai",
      language: "",
      transcriptionMode: "providers",
    }),
    { success: false, error: "Invalid API key. Check your key in Settings." }
  );

  const limited = setup({ transport: makeTransport({ statusCode: 429, data: {} }) });
  assert.deepEqual(
    await limited.call({
      filePath: audioFile,
      apiKey: "sk",
      provider: "openai",
      language: "",
      transcriptionMode: "providers",
    }),
    { success: false, error: "Rate limit exceeded. Please try again later." }
  );

  const providerError = setup({
    transport: makeTransport({ statusCode: 500, data: { error: { message: "boom" } } }),
  });
  assert.deepEqual(
    await providerError.call({
      filePath: audioFile,
      apiKey: "sk",
      provider: "openai",
      language: "",
      transcriptionMode: "providers",
    }),
    { success: false, error: "boom" }
  );

  const selfHostedError = setup({
    transport: makeTransport({ statusCode: 502, data: { error: "gateway down" } }),
  });
  const r = await selfHostedError.call({
    filePath: audioFile,
    provider: "custom",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.example.com/v1",
    remoteTranscriptionModel: "m",
    language: "",
  });
  assert.deepEqual(r, { success: false, error: "gateway down" });
});

test("a malformed provider text never crosses the wire as junk", async () => {
  const junk = setup({ transport: makeTransport({ data: { text: 42 } }) });
  const result = await junk.call({
    filePath: audioFile,
    apiKey: "sk",
    provider: "openai",
    language: "",
    transcriptionMode: "providers",
  });
  // The projection drops a non-string text instead of forwarding it, so the
  // renderer's !res.text guard reports a failed upload rather than saving 42.
  assert.equal(result.success, true);
  assert.equal(result.text, undefined);
});

test("invalid payloads are rejected before path resolution, read or network", async () => {
  const { call, calls, transport } = setup();
  assert.deepEqual(await call(null), { success: false, error: "Invalid file path" });
  assert.deepEqual(await call({ filePath: 123 }), { success: false, error: "Invalid file path" });
  assert.deepEqual(await call({ filePath: "/etc/hosts", apiKey: "x" }), {
    success: false,
    error: "File path not allowed",
  });
  assert.deepEqual(await call({ filePath: audioFile, requestId: "" }), {
    success: false,
    error: "Invalid transcription request",
  });
  assert.deepEqual(await call({ filePath: audioFile, diarize: "yes" }), {
    success: false,
    error: "Invalid transcription request",
  });
  assert.equal(calls.reads.length, 0);
  assert.equal(transport.calls.length, 0);
});

test("hard cancel aborts the in-flight transport and reports UPLOAD_CANCELLED", async () => {
  const { call, registry } = setup({
    transport: {
      postMultipart: (url, body, boundary, headers, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    },
  });
  const pending = call({
    filePath: audioFile,
    apiKey: "sk",
    provider: "openai",
    language: "",
    transcriptionMode: "providers",
    requestId: "cancel-me",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const aborted = registry.cancel("cancel-me");
  assert.equal(aborted, 1);
  assert.deepEqual(await pending, { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" });
  // The release in finally removed the controller: a second cancel is a no-op.
  assert.equal(registry.cancel("cancel-me"), 0);
});

test("a transport without a requestId registers nothing and stays cancellable-free", async () => {
  const { call, registry } = setup();
  await call({
    filePath: audioFile,
    apiKey: "sk",
    provider: "openai",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(registry.cancel("never-registered"), 0);
});
