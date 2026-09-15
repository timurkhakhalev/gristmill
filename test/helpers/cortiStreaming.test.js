const test = require("node:test");
const assert = require("node:assert/strict");

const CortiStreaming = require("../../src/helpers/cortiStreaming.ts");

test("Corti URL and config retain tenant, environment, language, rate, and keyterms", () => {
  const streaming = new CortiStreaming();
  streaming.sampleRate = 24_000;

  const url = new URL(
    streaming.buildWebSocketUrl({
      token: "oauth-token",
      environment: "eu",
      tenant: "tenant-a",
    })
  );
  assert.equal(url.origin, "wss://api.eu.corti.app");
  assert.equal(url.pathname, "/audio-bridge/v2/transcribe");
  assert.equal(url.searchParams.get("tenant-name"), "tenant-a");
  assert.equal(url.searchParams.get("token"), "Bearer oauth-token");
  assert.deepEqual(
    streaming.buildConfiguration({
      language: "da",
      keyterms: ["OpenHercules", "Corti"],
    }),
    {
      primaryLanguage: "da",
      interimResults: true,
      automaticPunctuation: true,
      audioFormat: "audio/pcm; rate=24000; channels=1; bits=16",
      keyterms: { terms: [{ term: "OpenHercules" }, { term: "Corti" }] },
    }
  );
});

test("transcript fixtures preserve partial, final, and session-relative timing callbacks", () => {
  const streaming = new CortiStreaming();
  const partials = [];
  const finals = [];
  streaming.sessionStartedAt = 4_000;
  streaming.onPartialTranscript = (text) => partials.push(text);
  streaming.onFinalTranscript = (text, startedAt) => finals.push({ text, startedAt });

  streaming.handleMessage(Buffer.from("{"));
  streaming.handleMessage(
    Buffer.from(JSON.stringify({ type: "transcript", data: { text: { malformed: true } } }))
  );
  streaming.handleMessage(
    Buffer.from(JSON.stringify({ type: "transcript", data: { text: "Good" } }))
  );
  streaming.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "transcript",
        data: { text: "Good morning", isFinal: true, start: 0.5 },
      })
    )
  );

  assert.deepEqual(partials, ["Good"]);
  assert.deepEqual(finals, [{ text: "Good morning", startedAt: 4_500 }]);
  assert.deepEqual(streaming.completedSegments, ["Good morning"]);
});

test("disconnect keeps Corti's flush-then-end handshake and remains bounded by its ack wait", async () => {
  const sent = [];
  const socket = {
    readyState: 1,
    send: (data) => sent.push(JSON.parse(data)),
    close() {
      this.readyState = 3;
    },
  };
  const streaming = new CortiStreaming();
  streaming.ws = socket;
  streaming.isConnected = true;
  streaming.configAccepted = true;
  streaming.accumulatedText = "final text";

  const resultPromise = streaming.disconnect(true);
  assert.deepEqual(sent, [{ type: "flush" }]);
  streaming.handleMessage(Buffer.from(JSON.stringify({ type: "flushed" })));

  assert.deepEqual(await resultPromise, { text: "final text" });
  assert.deepEqual(sent, [{ type: "flush" }, { type: "end" }]);
  assert.equal(streaming.ws, null);
});

test("disconnect before config acceptance closes without publishing a session loss", async () => {
  const losses = [];
  const socket = {
    readyState: 0,
    send() {
      throw new Error("must not send before ready");
    },
    close() {
      this.readyState = 3;
    },
  };
  const streaming = new CortiStreaming();
  streaming.ws = socket;
  streaming.onConnectionLost = (error) => losses.push(error.message);

  assert.deepEqual(await streaming.disconnect(true), { text: "" });
  assert.deepEqual(losses, []);
  assert.equal(streaming.ws, null);
});
