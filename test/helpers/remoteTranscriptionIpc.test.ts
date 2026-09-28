// The typed transcribe-audio-file-byok handler after the cutover: fake
// transports and provider clients over a real temp file, real route resolver
// and the real shared cancel registry. Pins payload validation before any
// work, the auth/route dialects, provider size caps, the diarization
// projection, malformed provider responses and the hard-cancel contract.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
import type { RemoteTranscriptionDeps } from "../../src/helpers/remoteTranscriptionIpcHandler.ts";
import type { RemoteTranscriptionResult } from "../../src/contracts/uploadTranscription.ts";
type Segment = NonNullable<RemoteTranscriptionResult["segments"]>[number];

let registerRemoteTranscriptionHandler: typeof import("../../src/helpers/remoteTranscriptionIpcHandler.ts").registerRemoteTranscriptionHandler;
let transcribeAudioFileByok: typeof import("../../src/helpers/remoteTranscriptionIpcHandler.ts").transcribeAudioFileByok;
let createUploadCancelRegistry: typeof import("../../src/helpers/uploadCancelRegistry.ts").createUploadCancelRegistry;

test.before(async () => {
  ({ registerRemoteTranscriptionHandler, transcribeAudioFileByok } =
    await import("../../src/helpers/remoteTranscriptionIpcHandler.ts"));
  ({ createUploadCancelRegistry } = await import("../../src/helpers/uploadCancelRegistry.ts"));
});

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-byok-typed-")));
const audioFile = path.join(tmpRoot, "audio.wav");
fs.writeFileSync(audioFile, Buffer.alloc(2048));

function makeTransport({ statusCode = 200, data = { text: "transcribed" } }: { statusCode?: number; data?: unknown } = {}) {
  const calls: any[] = [];
  return {
    calls,
    postMultipart: async (url: URL, body: Buffer, boundary: string, headers?: Record<string, string>, options?: { signal?: AbortSignal }) => {
      calls.push({ url: String(url), body, boundary, headers, options });
      return { statusCode, data };
    },
    postRawAudioFile: async (url: URL, filePath: string, contentType: string, apiKey: string, options?: { signal?: AbortSignal; multipart?: { fileName: string; fields: Record<string, string> } }) => {
      calls.push({ url: String(url), filePath, contentType, apiKey, options });
      return { statusCode, data };
    },
  };
}

function baseDeps(overrides: {
  transport?: ReturnType<typeof makeTransport>;
  uploadCancelRegistry?: ReturnType<typeof createUploadCancelRegistry>;
  deps?: Partial<RemoteTranscriptionDeps>;
} = {}) {
  const transport = overrides.transport || makeTransport();
  const registry = overrides.uploadCancelRegistry || createUploadCancelRegistry();
  const calls: {
    reads: string[];
    corti: Parameters<RemoteTranscriptionDeps["transcribeWithCorti"]>[0][];
    tinfoil: Parameters<RemoteTranscriptionDeps["transcribeWithTinfoil"]>[0][];
    gemini: Parameters<RemoteTranscriptionDeps["transcribeGeminiFile"]>[0][];
    warns: { message: string; data?: unknown }[];
    errors: { message: string; data?: unknown }[];
  } = {
    reads: [],
    corti: [],
    tinfoil: [],
    gemini: [],
    warns: [],
    errors: [],
  };
  const deps = {
    resolveAllowedAudioPath: (filePath: string) => {
      try {
        const real = fs.realpathSync(path.resolve(filePath));
        return real.startsWith(tmpRoot + path.sep) ? real : null;
      } catch {
        return null;
      }
    },
    readFile: (filePath: string) => {
      calls.reads.push(filePath);
      return fs.readFileSync(filePath);
    },
    fileSize: (filePath: string) => fs.statSync(filePath).size,
    providerBaseUrls: () => [],
    postMultipart: transport.postMultipart,
    postRawAudioFile: transport.postRawAudioFile,
    transcribeWithTinfoil: async (args: Parameters<RemoteTranscriptionDeps["transcribeWithTinfoil"]>[0]) => {
      calls.tinfoil.push(args);
      return { text: "tinfoil text" };
    },
    transcribeGeminiFile: async (args: Parameters<RemoteTranscriptionDeps["transcribeGeminiFile"]>[0]) => {
      calls.gemini.push(args);
      return { success: true, text: "gemini text" };
    },
    transcribeWithCorti: async (args: Parameters<RemoteTranscriptionDeps["transcribeWithCorti"]>[0]) => {
      calls.corti.push(args);
      return { text: "corti text" };
    },
    getCortiClientId: () => "corti-id",
    getCortiClientSecret: () => "corti-secret",
    getTinfoilKey: () => "tinfoil-key",
    getGeminiKey: () => "gemini-key",
    uploadCancelRegistry: registry,
    logDebug: () => {},
    logWarn: (message: string, data: unknown) => calls.warns.push({ message, data }),
    logError: (message: string, data: unknown) => calls.errors.push({ message, data }),
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
    result.segments.map((s: Segment) => s.speaker),
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

test("ElevenLabs streams multipart Scribe audio and groups timed speaker words", async () => {
  const transport = makeTransport({
    data: {
      text: "Hello there. Reply.",
      words: [
        { text: "Hello", start: 0, end: 0.4, type: "word", speaker_id: "speaker_0" },
        { text: " ", type: "spacing" },
        { text: "there.", start: 0.5, end: 0.9, type: "word", speaker_id: "speaker_0" },
        { text: " ", type: "spacing" },
        { text: "Reply.", start: 1.2, end: 1.8, type: "word", speaker_id: "speaker_1" },
      ],
    },
  });
  const { call, calls } = setup({ transport });
  const result = await call({
    filePath: audioFile,
    apiKey: "el-secret",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "ru",
    diarize: true,
    requestId: "elevenlabs-1",
  });
  assert.equal(result.success, true);
  assert.equal(result.diarized, true);
  assert.deepEqual(
    result.segments.map((s: Segment) => s.speaker),
    ["Speaker 1", "Speaker 2"]
  );
  assert.equal(result.segments[0].text, "Hello there. ");
  assert.equal(result.segments[0].end, 0.9);
  assert.match(result.text, /Hello there\./);
  assert.equal(transport.calls[0].url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(transport.calls[0].apiKey, "el-secret");
  assert.equal(transport.calls[0].options.multipart.fields.model_id, "scribe_v2");
  assert.equal(transport.calls[0].options.multipart.fields.diarize, "true");
  assert.equal(transport.calls[0].options.multipart.fields.language_code, "ru");
  assert.equal(calls.reads.length, 0);
});

test("ElevenLabs preserves word timestamps without diarization", async () => {
  const transport = makeTransport({
    data: {
      text: "Hello there.",
      words: [
        { text: "Hello", start: 0, end: 0.4, type: "word" },
        { text: " ", type: "spacing" },
        { text: "there.", start: 0.5, end: 0.9, type: "word" },
        { text: "[noise]", type: "audio_event" },
      ],
    },
  });
  const { call } = setup({ transport });
  const result = await call({ filePath: audioFile, provider: "elevenlabs", apiKey: "el-secret" });
  assert.equal(result.success, true);
  assert.equal(result.text, "Hello there.");
  assert.equal(result.diarized, false);
  assert.deepEqual(result.segments, [
    { text: "Hello ", start: 0, end: 0.4 },
    { text: "there.", start: 0.5, end: 0.9 },
  ]);
  assert.equal(transport.calls[0].options.multipart.fields.diarize, "false");
  assert.equal(transport.calls[0].options.multipart.fields.timestamps_granularity, "word");
});

test("ElevenLabs keeps plain text when timestamps are absent and rejects invalid timestamps", async () => {
  const input = { filePath: audioFile, provider: "elevenlabs", apiKey: "el-secret" };
  const missing = setup({ transport: makeTransport({ data: { text: "Hello" } }) });
  assert.deepEqual(await missing.call(input), { success: true, text: "Hello" });
  const invalid = setup({
    transport: makeTransport({
      data: { text: "Hello", words: [{ text: "Hello", type: "word", start: 1, end: 0 }] },
    }),
  });
  assert.equal((await invalid.call(input)).code, "ELEVENLABS_INVALID_RESPONSE");
});

test("ElevenLabs fails closed on missing speakers, invalid words and oversized files", async () => {
  const input = { filePath: audioFile, provider: "elevenlabs", apiKey: "el-secret", diarize: true };
  const missing = setup({ transport: makeTransport({ data: { text: "Hello", words: [] } }) });
  assert.equal((await missing.call(input)).code, "ELEVENLABS_DIARIZATION_MISSING");
  const invalid = setup({
    transport: makeTransport({
      data: {
        text: "Hello",
        words: [{ text: "Hello", type: "word", start: 1, end: 0, speaker_id: "speaker_0" }],
      },
    }),
  });
  assert.equal((await invalid.call(input)).code, "ELEVENLABS_INVALID_RESPONSE");
  const limited = setup({ deps: { fileSize: () => 3 * 1024 * 1024 * 1024 + 1 } });
  assert.match((await limited.call(input)).error, /3072 MB/);
  assert.equal(limited.transport.calls.length, 0);
  assert.match((await missing.call({ ...input, apiKey: "" })).error, /ElevenLabs API key/);
  const unauthorized = setup({ transport: makeTransport({ statusCode: 401 }) });
  assert.match((await unauthorized.call(input)).error, /Invalid ElevenLabs API key/);
});

function setup(overrides = {}) {
  const { deps, calls, transport, registry } = baseDeps(overrides);
  const handlers = new Map();
  registerRemoteTranscriptionHandler({ handle: (channel: string, fn: unknown) => handlers.set(channel, fn) }, deps);
  const call = (payload: unknown) => handlers.get("transcribe-audio-file-byok")(null, payload);
  return { call, calls, transport, registry, handlers, deps };
}

test("meeting raw-response sink is awaited before Deepgram parsing", async () => {
  const { deps } = setup({
    transport: makeTransport({ data: { results: {} } }),
  });
  const saved: unknown[] = [];
  const result = await transcribeAudioFileByok(
    deps,
    {
      filePath: audioFile,
      apiKey: "dg-secret",
      provider: "deepgram",
      model: "nova-3",
      transcriptionMode: "providers",
      requestId: "meeting-raw-before-parse",
    },
    {
      onRawProviderResponse: async (response: unknown) => {
        saved.push(response);
        throw Object.assign(new Error("durable save failed"), { code: "RAW_SAVE_FAILED" });
      },
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "RAW_SAVE_FAILED");
  assert.deepEqual(saved, [{ results: {} }]);
});

test("meeting raw-response sink is awaited before ElevenLabs parsing", async () => {
  const raw = {
    text: "Hello.",
    words: [{ type: "word", text: "Hello.", start: 0, end: 0.5, speaker_id: "speaker_0" }],
  };
  const { deps } = setup({ transport: makeTransport({ data: raw }) });
  let saved;
  const result = await transcribeAudioFileByok(
    deps,
    {
      filePath: audioFile,
      apiKey: "el-secret",
      provider: "elevenlabs",
      model: "scribe_v2",
      diarize: true,
      transcriptionMode: "providers",
      requestId: "meeting-elevenlabs-raw-before-parse",
    },
    {
      onRawProviderResponse: async (response: unknown) => {
        saved = response;
        throw Object.assign(new Error("durable save failed"), { code: "RAW_SAVE_FAILED" });
      },
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "RAW_SAVE_FAILED");
  assert.deepEqual(saved, raw);
});

test("meeting raw-response sink is awaited before OpenAI parsing", async () => {
  const raw = {
    text: "Hello.",
    segments: [{ speaker: "A", text: "Hello.", start: 0, end: 0.5 }],
  };
  const { deps } = setup({ transport: makeTransport({ data: raw }) });
  let saved;
  const result = await transcribeAudioFileByok(
    deps,
    {
      filePath: audioFile,
      apiKey: "sk",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      diarize: true,
      transcriptionMode: "providers",
      requestId: "meeting-openai-raw-before-parse",
    },
    {
      onRawProviderResponse: async (response: unknown) => {
        saved = response;
        throw Object.assign(new Error("durable save failed"), { code: "RAW_SAVE_FAILED" });
      },
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "RAW_SAVE_FAILED");
  assert.deepEqual(saved, raw);
});

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
  const selfHosted = setup({ deps: { fileSize: () => 26 * 1024 * 1024 } });
  const ok = await selfHosted.call({
    filePath: audioFile,
    provider: "custom",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.example.com/v1",
    remoteTranscriptionModel: "whisper-1",
    language: "",
  });
  assert.equal(ok.success, true);
  assert.deepEqual(selfHosted.transport.calls[0].headers, {}, "auth scheme none");

  const byok = setup({ deps: { fileSize: () => 26 * 1024 * 1024 } });
  const capped = await byok.call({
    filePath: audioFile,
    apiKey: "sk",
    provider: "openai",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(capped.success, false);
  assert.match(capped.error, /25 MB/);
  assert.equal(byok.transport.calls.length, 0);
  assert.equal(byok.calls.reads.length, 0);

  const geminiCapped = setup({
    deps: { fileSize: () => 2 * 1024 * 1024 * 1024 + 1 },
  });
  const gemini = await geminiCapped.call({
    filePath: audioFile,
    apiKey: "gk",
    provider: "gemini",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(gemini.success, false);
  assert.match(gemini.error, /2048 MB/);
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
    diarize: true,
    language: "de",
    transcriptionMode: "providers",
    requestId: "gemini-req",
  });
  assert.equal(gemini.calls.gemini[0].signal instanceof AbortSignal, true);
  assert.equal(gemini.calls.gemini[0].apiKey, "gk");
  assert.equal(gemini.calls.gemini[0].filePath, audioFile);
  assert.equal(gemini.calls.gemini[0].diarize, true);
  assert.equal(gemini.calls.reads.length, 0, "Gemini streams the selected file");
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
    result.segments.map((s: Segment) => s.speaker),
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
      postMultipart: (url: string, body: unknown, boundary: unknown, headers: unknown, options: { signal: AbortSignal }) =>
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
