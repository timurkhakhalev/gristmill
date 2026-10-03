const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const http: typeof import("node:http") = require("node:http");

const WhisperServerManager = require("../../src/helpers/whisperServer");
const WhisperManager: typeof import("../../src/helpers/whisper").WhisperManager = require("../../src/helpers/whisper");
const { INFERENCE_DECODER_FIELDS } = WhisperServerManager;

function startCapturingServer() {
  let captured: string | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      captured = Buffer.concat(chunks).toString("latin1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "ok" }));
    });
  });
  return new Promise<{ server: import("node:http").Server; port: number; getBody: () => string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      resolve({ server, port: address.port, getBody: () => {
        assert.ok(captured);
        return captured;
      } });
    });
  });
}

function createManager(port: number) {
  const manager = new WhisperServerManager();
  manager.ready = true;
  manager.hostname = "127.0.0.1";
  manager.port = port;
  manager.canConvert = true;
  manager.process = {};
  manager.modelPath = "/tmp/model.bin";
  manager._convertToWav = async (buffer: unknown) => buffer;
  return manager;
}

function fieldValue(body: string, name: string) {
  const match = body.match(
    new RegExp(`Content-Disposition: form-data; name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`)
  );
  return match ? match[1] : null;
}

test("pins the measured anti-hallucination thresholds from #1458", () => {
  assert.deepEqual(INFERENCE_DECODER_FIELDS, {
    entropy_thold: "2.8",
    logprob_thold: "-1.25",
  });
});

test("sends the decoder threshold fields alongside the existing inference fields", async (t: import("node:test").TestContext) => {
  const { server, port, getBody } = await startCapturingServer();
  t.after(() => server.close());

  const manager = createManager(port);
  const result = await manager.transcribe(Buffer.from("audio"), {
    language: "auto",
    initialPrompt: "OpenWhispr",
  });
  assert.equal(result.text, "ok");

  const body = getBody();
  for (const [name, value] of Object.entries(INFERENCE_DECODER_FIELDS)) {
    assert.equal(fieldValue(body, name), value, `expected ${name}=${value} in the request body`);
  }
  assert.equal(fieldValue(body, "language"), "auto");
  assert.equal(fieldValue(body, "prompt"), "OpenWhispr");
  assert.equal(fieldValue(body, "response_format"), "json");

  // Field order: file, language, decoder thresholds, prompt, response_format, closing boundary.
  const positions = ['name="file"', 'name="language"']
    .concat(Object.keys(INFERENCE_DECODER_FIELDS).map((name) => `name="${name}"`))
    .concat(['name="prompt"', 'name="response_format"'])
    .map((marker) => body.indexOf(marker));
  assert.ok(
    positions.every((pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1])),
    `expected ordered form fields, got positions ${positions.join(", ")}`
  );

  const boundary = body.slice(0, body.indexOf("\r\n"));
  assert.ok(body.endsWith(`${boundary}--\r\n`), "expected the closing boundary to end the body");
});

test("sends the decoder threshold fields even without an initial prompt", async (t: import("node:test").TestContext) => {
  const { server, port, getBody } = await startCapturingServer();
  t.after(() => server.close());

  const manager = createManager(port);
  await manager.transcribe(Buffer.from("audio"), { language: "en" });

  const body = getBody();
  for (const [name, value] of Object.entries(INFERENCE_DECODER_FIELDS)) {
    assert.equal(fieldValue(body, name), value, `expected ${name}=${value} in the request body`);
  }
  assert.equal(fieldValue(body, "language"), "en");
  assert.equal(fieldValue(body, "prompt"), null);
  assert.equal(fieldValue(body, "response_format"), "json");
});

test("skipDecoderThresholds omits the raised fields so the server keeps its defaults", async (t: import("node:test").TestContext) => {
  const { server, port, getBody } = await startCapturingServer();
  t.after(() => server.close());

  const manager = createManager(port);
  const result = await manager.transcribe(Buffer.from("audio"), {
    language: "en",
    skipDecoderThresholds: true,
  });
  assert.equal(result.text, "ok");

  const body = getBody();
  for (const name of Object.keys(INFERENCE_DECODER_FIELDS)) {
    assert.equal(fieldValue(body, name), null, `expected ${name} to be omitted`);
  }
  assert.equal(fieldValue(body, "language"), "en");
  assert.equal(fieldValue(body, "response_format"), "json");
});

test("transcribeLocalWhisper plumbs skipDecoderThresholds to the server request (meeting chunks)", async () => {
  const manager = new WhisperManager();
  const captured: any[] = [];
  manager.serverManager.isAvailable = () => true;
  manager.serverManager.start = async () => {};
  manager.serverManager.transcribe = async (_buffer: unknown, options: unknown) => {
    captured.push(options);
    return { text: "ok" };
  };
  manager.getModelPath = () => __filename;

  await manager.transcribeLocalWhisper(Buffer.from("audio"), {
    model: "base",
    skipDecoderThresholds: true,
  });
  assert.equal(captured[0].skipDecoderThresholds, true);

  // Every caller that does not opt out (dictation, note uploads) keeps the raised fields.
  await manager.transcribeLocalWhisper(Buffer.from("audio"), { model: "base" });
  assert.equal(captured[1].skipDecoderThresholds, false);
});

test("#161: transcribe passes the cancellation signal into the WAV conversion", async (t: import("node:test").TestContext) => {
  const { server, port } = await startCapturingServer();
  t.after(() => server.close());

  const manager = createManager(port);
  const conversionSignals: unknown[] = [];
  manager._convertToWav = async (buffer: unknown, signal?: unknown) => {
    conversionSignals.push(signal);
    return buffer;
  };
  const controller = new AbortController();
  await manager.transcribe(Buffer.from("audio"), { signal: controller.signal });

  assert.equal(conversionSignals.length, 1);
  assert.equal(conversionSignals[0], controller.signal, "ffmpeg conversion must be cancellable");
});
