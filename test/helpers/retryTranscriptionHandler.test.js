const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const https = require("node:https");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const execModuleSpecifier = "../../src/helpers/transcriptionExecutionIpcHandlers";
const { createUploadCancelRegistry } = require("../../src/helpers/uploadCancelRegistry");
const originalLoad = Module._load;
const originalHttpsRequest = https.request;

// Captures every ipcMain.handle registration and every net.fetch request so the
// registered handler closures can be invoked directly. `handlers` holds the
// channels still registered from ipcHandlers.js (the BYOK upload path);
// `execHandlers` holds the typed transcription execution module's channels.
const handlers = new Map();
const execHandlers = new Map();
const fetches = [];
const geminiFileCalls = [];
let fetchResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: "transcribed" }),
  text: async () => JSON.stringify({ text: "transcribed" }),
});

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: {
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      return fetchResponse(String(url), init);
    },
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

const cortiCalls = [];
const tinfoilCalls = [];
let cortiBehavior = async () => ({ text: "corti text" });

// Kept installed for the whole file: the corti client is require()d lazily at
// handler invocation time, not at module load.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./cortiTranscription") {
      return {
        transcribeAudio: async (opts) => {
          cortiCalls.push(opts);
          return cortiBehavior(opts);
        },
      };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async (opts) => {
          tinfoilCalls.push(opts);
          return { text: "tinfoil text", model: "tinfoil-model" };
        },
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by the upload handler can be an inert stub.
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

// The typed transcription execution module's deps: the same key fixtures the
// old fake-this carried, now passed explicitly to the register function.
function buildExecutionDeps() {
  const dbRows = new Map([[7, { id: 7, audio_duration_ms: 1200 }]]);
  return {
    whisperManager: { transcribeLocalWhisper: async () => ({ success: true, text: "" }) },
    parakeetManager: { transcribeLocalParakeet: async () => ({ success: true, text: "" }) },
    resolveWhisperVadOptions: () => ({ vadEnabled: false }),
    environmentManager: {
      getOpenAIKey: () => "sk-openai",
      getGroqKey: () => "gk-groq",
      getMistralKey: () => "mk-mistral",
      getXaiKey: () => "xk-xai",
      getTinfoilKey: () => "tk-tinfoil",
      getGeminiKey: () => "gk-gemini",
      getDeepgramKey: () => "dk-deepgram",
      getElevenLabsKey: () => "ek-elevenlabs",
      getCustomTranscriptionKey: () => "ck-custom",
      getCortiClientId: () => "corti-id",
      getCortiClientSecret: () => "corti-secret",
    },
    proxyFetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      return fetchResponse(String(url), init);
    },
    transcribeGeminiFile: async (args) => {
      geminiFileCalls.push({
        ...args,
        bytes: require("node:fs").readFileSync(args.filePath),
      });
      return { success: true, text: "Gemini retry text" };
    },
    transcribeWithCorti: async (opts) => {
      cortiCalls.push(opts);
      return cortiBehavior(opts);
    },
    mintStoredCortiToken: async () => ({ token: "test-token" }),
    generateText: async () => ({}),
    getEnterpriseAIModel: () => ({}),
    bedrockSdk: async () => {
      throw new Error("AWS SDK is lazy and not exercised by these tests");
    },
    bedrockProfileCredentials: () => null,
    providerBaseUrls: () =>
      require("../../src/models/modelRegistryData.json").transcriptionProviders,
    audioStorage: { getAudioBuffer: (id) => (id === 7 ? Buffer.from([1, 2, 3]) : null) },
    database: {
      updateTranscriptionText: () => {},
      updateTranscriptionStatus: () => {},
      updateTranscriptionAudio: () => {},
      getTranscriptionById: (id) => dbRows.get(id) ?? null,
    },
    broadcast: () => {},
    logger: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  };
}

// The upload path still registers through ipcHandlers.js; its harness is the
// same fake-this the file always used.
function buildUploadFakeThis() {
  const target = {
    sessionId: "test-session",
    // The real registry: the extracted byok handler registers every upload
    // here, and a proxy stub would fake a permanently-aborted signal.
    _uploadCancelRegistry: createUploadCancelRegistry(),
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(buildUploadFakeThis());
});

// The retry/proxy/model-discovery channels register through the typed module.
let retryHandler;
test.before(() => {
  const { registerTranscriptionExecutionHandlers } = require(execModuleSpecifier);
  registerTranscriptionExecutionHandlers(
    { handle: (channel, fn) => execHandlers.set(channel, fn) },
    buildExecutionDeps()
  );
  retryHandler = execHandlers.get("retry-transcription");
  assert.ok(retryHandler, "retry-transcription must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

const invoke = (settings, id = 7) => retryHandler({ sender: {} }, id, settings);

test("retry: corti routes to the corti client, never OpenAI", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cortiEnvironment: "eu",
    cortiTenant: "acme",
    preferredLanguage: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(cortiCalls.length, 1);
  assert.equal(cortiCalls[0].environment, "eu");
  assert.equal(cortiCalls[0].tenant, "acme");
  assert.equal(cortiCalls[0].language, "en");
  assert.equal(fetches.length, 0, "corti retry must not touch HTTP endpoints");
});

test("retry: custom misconfiguration fails closed with a coded error", async () => {
  fetches.length = 0;
  for (const cloudTranscriptionBaseUrl of ["", "https://api.openai.com/v1", "not a url"]) {
    const result = await invoke({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cloudTranscriptionBaseUrl,
    });
    assert.equal(result.success, false, cloudTranscriptionBaseUrl);
    assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID", cloudTranscriptionBaseUrl);
  }
  assert.equal(fetches.length, 0);
});

test("retry: Azure custom endpoints get deployment URLs and api-key auth", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://myres.openai.azure.com",
    cloudTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /myres\.openai\.azure\.com\/openai\/deployments\/my-deployment/);
  assert.equal(fetches[0].init.headers["api-key"], "ck-custom");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
});

test("retry: plain custom endpoints use Bearer auth at the configured URL", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
    cloudTranscriptionModel: "parasail-model",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].url, "https://stt.parasail.example.com/v1/audio/transcriptions");
  assert.equal(fetches[0].init.headers.Authorization, "Bearer ck-custom");
});

test("retry: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
  assert.equal(tinfoilCalls.length, 0);
});

test("retry: mistral goes to Mistral with x-api-key", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
});

test("retry: Deepgram sends raw audio to its own file endpoint", async () => {
  fetches.length = 0;
  fetchResponse = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: {
        channels: [{ alternatives: [{ transcript: "retried speech" }] }],
        utterances: [{ start: 0, end: 1, transcript: "retried speech" }],
      },
    }),
    text: async () => "",
  });
  try {
    const result = await invoke({
      cloudTranscriptionProvider: "deepgram",
      cloudTranscriptionModel: "nova-3",
      transcriptionMode: "providers",
      preferredLanguage: "auto",
    });
    assert.equal(result.success, true);
    assert.equal(new URL(fetches[0].url).origin, "https://api.deepgram.com");
    assert.equal(new URL(fetches[0].url).searchParams.get("detect_language"), "true");
    assert.equal(fetches[0].init.headers.Authorization, "Token dk-deepgram");
    assert.equal(fetches[0].init.headers["Content-Type"], "audio/webm");
    assert.ok(Buffer.isBuffer(fetches[0].init.body));
  } finally {
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

test("retry: Gemini uses the file transcription path and removes its temp file", async () => {
  geminiFileCalls.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "gemini",
    cloudTranscriptionModel: "gemini-3.5-transcribe",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.equal(geminiFileCalls.length, 1);
  assert.equal(geminiFileCalls[0].model, "gemini-3.5-transcribe");
  assert.deepEqual(geminiFileCalls[0].bytes, Buffer.from([1, 2, 3]));
  assert.equal(geminiFileCalls[0].diarize, false);
  assert.equal(require("node:fs").existsSync(geminiFileCalls[0].filePath), false);
});

test("retry: ElevenLabs sends Scribe multipart audio with its own key", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "elevenlabs",
    cloudTranscriptionModel: "scribe_v2",
    transcriptionMode: "providers",
    preferredLanguage: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(fetches[0].init.headers["xi-api-key"], "ek-elevenlabs");
  assert.match(fetches[0].init.headers["Content-Type"], /multipart\/form-data/);
  assert.match(fetches[0].init.body.toString(), /name="model_id"\r\n\r\nscribe_v2/);
  assert.match(fetches[0].init.body.toString(), /name="diarize"\r\n\r\nfalse/);
});

test("proxy transcription handlers resolve to structured errors instead of rejecting", async () => {
  fetchResponse = () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
    json: async () => ({}),
  });
  cortiBehavior = async () => {
    const err = new Error("Corti API Error: 401");
    err.code = "INVALID_KEY";
    throw err;
  };
  try {
    for (const channel of [
      "proxy-mistral-transcription",
      "proxy-xai-transcription",
      "proxy-corti-transcription",
    ]) {
      const fn = execHandlers.get(channel);
      assert.ok(fn, `${channel} must be registered`);
      const result = await fn({ sender: {} }, { audioBuffer: new ArrayBuffer(4) });
      assert.equal(typeof result.error, "string", channel);
    }
  } finally {
    cortiBehavior = async () => ({ text: "corti text" });
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

const fsNode = require("node:fs");
const osNode = require("node:os");
const pathNode = require("node:path");

const uploadTempFile = pathNode.join(osNode.tmpdir(), "openwhispr-upload-handler-test.webm");

const invokeUpload = (payload) => {
  const uploadHandler = handlers.get("transcribe-audio-file-byok");
  assert.ok(uploadHandler, "transcribe-audio-file-byok must be registered");
  fsNode.writeFileSync(uploadTempFile, Buffer.from([1, 2, 3, 4]));
  return uploadHandler({ sender: {} }, { filePath: uploadTempFile, ...payload });
};

// postRawAudioFile moved onto Node https (aefbab8ec), so the upload tests
// intercept https.request instead of Electron net.request. The mock records
// headers and the streamed body, then answers like the real provider. The
// response must fully arrive before "close": the production code treats a
// close without a settled response as a transport failure.
function mockHttpsUpload({ onRequest }) {
  https.request = (url, options, callback) => {
    const { EventEmitter } = require("node:events");
    const request = new EventEmitter();
    const uploaded = [];
    request.write = (chunk, _encoding, cb) => {
      uploaded.push(Buffer.from(chunk));
      cb?.();
    };
    request.end = () => {
      queueMicrotask(() => {
        try {
          const { response } = onRequest(
            typeof url === "string" || url instanceof URL ? new URL(url) : url,
            options,
            Buffer.concat(uploaded)
          );
          const res = new EventEmitter();
          res.statusCode = 200;
          if (typeof callback === "function") callback(res);
          request.emit("response", res);
          res.emit("data", Buffer.from(JSON.stringify(response)));
          res.emit("end");
        } catch (error) {
          request.emit("error", error);
        }
      });
    };
    request.destroy = () => {};
    request.abort = () => request.emit("error", new Error("aborted"));
    request.on("error", () => {});
    return request;
  };
}

test("upload: Deepgram streams raw file bytes through Node https", async () => {
  fetches.length = 0;
  const uploaded = [];
  mockHttpsUpload({
    onRequest: (url, options, body) => {
      assert.equal(url.origin, "https://api.deepgram.com");
      assert.equal(options.headers.Authorization, "Token dg-key");
      assert.equal(options.headers["Content-Type"], "audio/webm");
      uploaded.push(body);
      return {
        body,
        response: {
          results: {
            channels: [{ alternatives: [{ transcript: "done" }] }],
            utterances: [{ start: 0, end: 1, transcript: "done", speaker: 0 }],
          },
        },
      };
    },
  });
  try {
    const result = await invokeUpload({ provider: "deepgram", apiKey: "dg-key", diarize: true });
    assert.equal(result.success, true);
    assert.equal(result.diarized, true);
    assert.deepEqual(Buffer.concat(uploaded), Buffer.from([1, 2, 3, 4]));
    assert.equal(fetches.length, 0);
  } finally {
    https.request = originalHttpsRequest;
  }
});

test("upload: ElevenLabs streams a complete multipart file with Scribe fields", async () => {
  mockHttpsUpload({
    onRequest: (url, options) => {
      assert.equal(url.toString(), "https://api.elevenlabs.io/v1/speech-to-text");
      assert.equal(options.headers["xi-api-key"], "el-key");
      assert.match(options.headers["Content-Type"], /multipart\/form-data; boundary=/);
      return { response: { text: "done" } };
    },
  });
  try {
    const result = await invokeUpload({ provider: "elevenlabs", apiKey: "el-key" });
    assert.equal(result.success, true);
  } finally {
    https.request = originalHttpsRequest;
  }
});

test("upload: mistral sends x-api-key with a provider-validated model and no language on auto", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "mk-mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "gpt-4o-mini-transcribe", // stale from an openai era — must degrade
    provider: "mistral",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
  const body = fetches[0].init.body.toString();
  assert.match(body, /voxtral-mini-latest/);
  assert.doesNotMatch(body, /name="language"/);
});

test("upload: openai diarization fields ride the route, Bearer auth", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    provider: "openai",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].init.headers.Authorization, "Bearer sk-openai");
  const body = fetches[0].init.body.toString();
  assert.match(body, /gpt-4o-transcribe-diarize/);
  assert.match(body, /diarized_json/);
});

test("upload: sentinel custom URL fails closed before any request", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.equal(fetches.length, 0);
});

test("upload: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://inference.tinfoil.sh/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
});

// An uploaded file is frequently not in the dictation language, and a wrong hint
// silently mistranscribes it — so BYOK cloud uploads auto-detect even when the
// user has pinned a preferred language for dictation.
test("upload: a preferred language never constrains a BYOK cloud upload", async () => {
  for (const provider of ["openai", "groq", "custom"]) {
    fetches.length = 0;
    const result = await invokeUpload({
      apiKey: "sk-key",
      baseUrl: provider === "custom" ? "https://gateway.example.com/v1" : "",
      model: "whisper-1",
      provider,
      language: "de",
      transcriptionMode: "providers",
    });
    assert.equal(result.success, true, provider);
    assert.doesNotMatch(fetches[0].init.body.toString(), /name="language"/, provider);
  }
});

// Providers that require a concrete language still receive one.
test("upload: corti and xai still get their language", async () => {
  fetches.length = 0;
  const xai = await invokeUpload({
    apiKey: "xk-key",
    baseUrl: "",
    model: "grok-stt",
    provider: "xai",
    language: "de",
    transcriptionMode: "providers",
  });
  assert.equal(xai.success, true);
  assert.match(fetches[0].url, /api\.x\.ai/);
  const xaiBody = fetches[0].init.body.toString();
  assert.match(xaiBody, /name="language"[\s\S]*?de/);
  assert.doesNotMatch(xaiBody, /name="model"/);

  const corti = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "corti-transcribe",
    provider: "corti",
    language: "",
    environment: "eu",
    tenant: " acme ",
    transcriptionMode: "providers",
  });
  assert.equal(corti.success, true);
  assert.equal(cortiCalls.at(-1).language, "en", "corti needs a concrete primaryLanguage");
  assert.equal(cortiCalls.at(-1).environment, "eu");
  assert.equal(cortiCalls.at(-1).tenant, "acme");
});

// #1459 made cloudTranscriptionBaseUrl Custom-only, so provider id alone can no
// longer tell whether a Custom endpoint fronts a diarization-capable API.
test("upload: a Custom endpoint fronting OpenAI or Mistral keeps diarization", async () => {
  fetches.length = 0;
  const openaiFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(openaiFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /gpt-4o-transcribe-diarize/);

  fetches.length = 0;
  const mistralFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.mistral.ai/v1/audio/transcriptions",
    model: "voxtral-mini-latest",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(mistralFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /name="diarize"/);

  fetches.length = 0;
  const unknownGateway = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://gateway.example.com/v1",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(unknownGateway.success, true, "an unknown gateway degrades, never fails");
  assert.doesNotMatch(fetches[0].init.body.toString(), /diarized_json/);
});

test("upload: a self-hosted Azure endpoint keeps its deployment URL", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "",
    provider: "custom",
    language: "",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.openai.azure.com",
    remoteTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(
    fetches[0].url,
    "https://myorg.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );
});
