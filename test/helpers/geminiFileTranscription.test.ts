const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs/promises") = require("node:fs/promises");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

type GeminiFileModule = typeof import("../../src/helpers/geminiFileTranscription.js");

let transcribeGeminiFile: GeminiFileModule["transcribeGeminiFile"];

let parseGeminiFileResponse: GeminiFileModule["parseGeminiFileResponse"];

let probeGeminiAudioDuration: GeminiFileModule["probeGeminiAudioDuration"];

let tempDir!: string;

let audioPath!: string;

test.before(async () => {
  ({ transcribeGeminiFile, parseGeminiFileResponse, probeGeminiAudioDuration } =
    await import("../../src/helpers/geminiFileTranscription.ts"));
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-file-test-"));
  audioPath = path.join(tempDir, "recording.webm");
  await fs.writeFile(audioPath, Buffer.alloc(12_345));
});

test.after(async () => fs.rm(tempDir, { recursive: true, force: true }));

const FILE_NAME = "files/audio-123";

const FILE_URI = "https://generativelanguage.googleapis.com/v1beta/files/audio-123";

const UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc";

const RESPONSE = {
  status: "completed",
  output_text: "Hello world. Reply.",
  steps: [
    {
      type: "model_output",
      content: [
        {
          type: "text",
          text: "Hello world. Reply.",
          annotations: [
            {
              type: "word_info",
              text: "Hello",
              speaker: "spk_1",
              start_offset: "0.100s",
              end_offset: "0.450s",
            },
            {
              type: "word_info",
              text: "world.",
              speaker: "spk_1",
              start_offset: "0.500s",
              end_offset: "0.850s",
            },
            {
              type: "word_info",
              text: "Reply.",
              speaker: "spk_2",
              start_offset: "1.200s",
              end_offset: "1.800s",
            },
          ],
        },
      ],
    },
  ],
};

function fakeResponse(
  body: unknown,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type FetchInit = {
  method?: string;
  headers: Record<string, string>;
  body?: { length: number } | string;
};

type FetchCall = { kind: "fetch"; url: string; init: FetchInit };

type ProbeCall = { kind: "probe"; path: string; signal: unknown };

function setup({
  duration = 60,
  interaction = RESPONSE,
  initialState = "ACTIVE",
}: { duration?: number | null; interaction?: unknown; initialState?: string } = {}) {
  const calls: Array<FetchCall | ProbeCall> = [];

  const deps = {
    probeDuration: async (path: string, signal: unknown) => {
      calls.push({ kind: "probe", path, signal });

      return duration;
    },
    fetch: async (url: string, init: FetchInit) => {
      calls.push({ kind: "fetch", url, init });

      if (url.endsWith("/upload/v1beta/files")) {
        return fakeResponse({}, { headers: { "x-goog-upload-url": UPLOAD_URL } });
      }

      if (url === UPLOAD_URL) {
        return fakeResponse({ file: { name: FILE_NAME, uri: FILE_URI, state: initialState } });
      }

      if (url.endsWith("/v1beta/interactions")) return fakeResponse(interaction);

      if (init.method === "DELETE") return fakeResponse({}, { status: 204 });

      if (url.endsWith("/v1beta/files/audio-123")) {
        return fakeResponse({ name: FILE_NAME, uri: FILE_URI, state: "ACTIVE" });
      }

      throw new Error("Unexpected request " + url);
    },
    wait: async () => {},
  };

  const request = {
    filePath: audioPath,
    fileSizeBytes: 12_345,
    contentType: "audio/webm",
    model: "gemini-3.5-transcribe",
    apiKey: "secret",
    diarize: true,
  };

  return { deps, request, calls };
}

test("uploads via Files API, requests word timestamps and diarization, then deletes the file", async () => {
  const { deps, request, calls } = setup();

  const result = await transcribeGeminiFile(
    request,
    deps as unknown as import("../../src/helpers/geminiFileTranscription.js").GeminiFileDeps
  );

  assert.equal(result.success, true);
  assert.equal(result.diarized, true);
  assert.deepEqual(
    result.segments!.map((s) => s.speaker),
    ["Speaker 1", "Speaker 2"]
  );
  assert.equal(result.segments![0].text, "Hello world.");
  assert.equal(result.segments![0].start, 0.1);
  assert.equal(result.segments![0].end, 0.85);

  const start = calls.find(
    (c): c is FetchCall => c.kind === "fetch" && c.url.endsWith("/upload/v1beta/files")
  );

  assert.equal(start!.init.headers["x-goog-api-key"], "secret");
  assert.equal(start!.init.headers["X-Goog-Upload-Header-Content-Length"], "12345");
  const upload = calls.find((c): c is FetchCall => c.kind === "fetch" && c.url === UPLOAD_URL)!;
  assert.equal((upload!.init.body as { length: number }).length, 12_345);
  assert.equal(upload.init.headers["X-Goog-Upload-Offset"], "0");
  assert.equal(upload.init.headers["X-Goog-Upload-Command"], "upload, finalize");

  const interaction = calls.find(
    (c): c is FetchCall => c.kind === "fetch" && c.url.endsWith("/v1beta/interactions")
  )!;

  const body = JSON.parse(interaction.init.body as string);
  assert.equal(body.input[0].uri, FILE_URI);
  assert.equal(body.model, "gemini-3.5-transcribe");
  assert.deepEqual(body.generation_config.transcription_config.mode, {
    type: "verbatim",
    diarization_mode: "speaker",
    timestamp_granularities: ["word"],
  });
  assert.equal((calls.at(-1) as FetchCall).init.method, "DELETE");
});

test("processing files are polled before transcription", async () => {
  const { deps, request, calls } = setup({ initialState: "PROCESSING" });
  assert.equal(
    (
      await transcribeGeminiFile(
        request,
        deps as unknown as import("../../src/helpers/geminiFileTranscription.js").GeminiFileDeps
      )
    ).success,
    true
  );
  assert.equal(
    calls.filter(
      (c) =>
        c.kind === "fetch" &&
        c.url.endsWith("/v1beta/files/audio-123") &&
        c.init.method !== "DELETE"
    ).length,
    1
  );
});

test("unsupported duration fails before any API call or file upload", async () => {
  for (const duration of [null, 1800.1]) {
    const { deps, request, calls } = setup({ duration });

    const result = await transcribeGeminiFile(
      request,
      deps as unknown as import("../../src/helpers/geminiFileTranscription.js").GeminiFileDeps
    );

    assert.equal(result.success, false);
    assert.equal(
      result.code,
      duration === null ? "GEMINI_DURATION_UNKNOWN" : "GEMINI_DURATION_LIMIT"
    );
    assert.equal(
      calls.some((c) => c.kind !== "probe"),
      false
    );
  }
});

test("large files upload in bounded chunks with consecutive offsets", async () => {
  const { deps, request, calls } = setup();
  const largePath = path.join(tempDir, "large.webm");
  const size = 8 * 1024 * 1024 + 7;
  await fs.writeFile(largePath, Buffer.alloc(size));
  request.filePath = largePath;
  request.fileSizeBytes = size;
  assert.equal(
    (
      await transcribeGeminiFile(
        request,
        deps as unknown as import("../../src/helpers/geminiFileTranscription.js").GeminiFileDeps
      )
    ).success,
    true
  );

  const uploads = calls.filter(
    (call): call is FetchCall => call.kind === "fetch" && call.url === UPLOAD_URL
  );

  assert.deepEqual(
    uploads.map((call) => [
      call.init.headers["X-Goog-Upload-Offset"],
      call.init.headers["X-Goog-Upload-Command"],
      (call.init.body as { length: number }).length,
    ]),
    [
      ["0", "upload", 8 * 1024 * 1024],
      [String(8 * 1024 * 1024), "upload, finalize", 7],
    ]
  );
});

test("duration probe reads the source audio without changing it", async () => {
  const wavPath = path.join(tempDir, "one-second.wav");
  const sampleBytes = 16_000 * 2;
  const wav = Buffer.alloc(44 + sampleBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(sampleBytes, 40);
  await fs.writeFile(wavPath, wav);
  assert.equal(await probeGeminiAudioDuration(wavPath), 1);
  assert.deepEqual(await fs.readFile(wavPath), wav);
});

test("missing annotations or speaker labels fail closed and still delete the file", async () => {
  for (const interaction of [
    { status: "completed", output_text: "Hello" },
    {
      ...RESPONSE,
      steps: [
        {
          content: [
            {
              annotations: [
                { type: "word_info", text: "Hello", start_offset: "0.100s", end_offset: "0.500s" },
              ],
            },
          ],
        },
      ],
    },
  ]) {
    const { deps, request, calls } = setup({ interaction });

    const result = await transcribeGeminiFile(
      request,
      deps as unknown as import("../../src/helpers/geminiFileTranscription.js").GeminiFileDeps
    );

    assert.equal(result.success, false);
    assert.ok(
      ["GEMINI_TIMESTAMPS_MISSING", "GEMINI_DIARIZATION_MISSING"].includes(result.code as string)
    );
    assert.equal((calls.at(-1) as FetchCall).init.method, "DELETE");
  }
});

test("incomplete interactions and invalid offsets are rejected", () => {
  assert.deepEqual(parseGeminiFileResponse({ status: "completed", output_text: "" }, true), {
    success: true,
    text: "",
    diarized: false,
    segments: [],
  });
  assert.equal(
    parseGeminiFileResponse({ status: "failed", output_text: "partial" }, true).code,
    "GEMINI_INCOMPLETE"
  );
  assert.equal(
    parseGeminiFileResponse(
      {
        ...RESPONSE,
        steps: [
          {
            content: [
              {
                annotations: [
                  {
                    type: "word_info",
                    text: "Hello",
                    speaker: "spk_1",
                    start_offset: "1s",
                    end_offset: "0.5s",
                  },
                ],
              },
            ],
          },
        ],
      },
      true
    ).code,
    "GEMINI_INVALID_RESPONSE"
  );
});

test("meeting raw interaction is saved before validation and Gemini file cleanup", async () => {
  const events: unknown[] = [];

  const { deps, request } = setup({
    interaction: { status: "completed", output_text: "Hello without word timestamps." },
  });

  const fetch = deps.fetch;
  deps.fetch = async (url, init) => {
    const response = await fetch(url, init);

    if (url.endsWith("/v1beta/interactions")) events.push("interaction-response");

    if (init.method === "DELETE") events.push("delete-uploaded-file");

    return response;
  };

  (request as { onRawResponse?: (raw: unknown) => Promise<void> }).onRawResponse = async (
    raw: unknown
  ) => {
    events.push("raw-saved");
    assert.deepEqual(raw, { status: "completed", output_text: "Hello without word timestamps." });
    throw new Error("durable save failed");
  };

  await assert.rejects(
    () =>
      transcribeGeminiFile(
        request,
        deps as unknown as import("../../src/helpers/geminiFileTranscription.js").GeminiFileDeps
      ),
    /durable save failed/
  );
  assert.deepEqual(events, ["interaction-response", "raw-saved", "delete-uploaded-file"]);
});
