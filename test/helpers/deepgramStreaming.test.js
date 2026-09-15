const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const DeepgramStreaming = require("../../src/helpers/deepgramStreaming.ts");

// Loopback Deepgram: warmup resolves on the socket opening, connect on the
// first server message, so every accepted socket answers with Metadata.
async function withMetadataServer(run) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const connections = [];
  const authHeaders = [];
  server.on("connection", (socket, request) => {
    connections.push(request.url);
    authHeaders.push(request.headers.authorization);
    socket.send(JSON.stringify({ type: "Metadata", request_id: `req-${connections.length}` }));
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`, connections, authHeaders);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("managed mode is rejected before opening a socket", async () => {
  const streaming = new DeepgramStreaming();
  await assert.rejects(
    () => streaming.warmup({ token: "managed-token", mode: "openwhispr" }),
    /requires a direct provider API key/
  );
});

test("Results fixtures preserve partial, final, and session-relative timing callbacks", () => {
  const streaming = new DeepgramStreaming();
  const partials = [];
  const finals = [];
  streaming.sessionStartedAt = 2_000;
  streaming.onPartialTranscript = (text) => partials.push(text);
  streaming.onFinalTranscript = (text, startedAt) => finals.push({ text, startedAt });

  streaming.handleMessage(Buffer.from("{"));
  streaming.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "Results",
        channel: { alternatives: [{ transcript: { malformed: true } }] },
      })
    )
  );
  streaming.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "Results",
        channel: { alternatives: [{ transcript: "Hello" }] },
      })
    )
  );
  streaming.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "Results",
        is_final: true,
        start: 1.25,
        channel: { alternatives: [{ transcript: "Hello world" }] },
      })
    )
  );

  assert.deepEqual(partials, ["Hello"]);
  assert.deepEqual(finals, [{ text: "Hello world", startedAt: 3_250 }]);
  assert.deepEqual(streaming.completedSegments, ["Hello world"]);
});

// Keeps the real query string (language, keyterms) while dialing the loopback server.
function dialLoopback(streaming, url) {
  const buildRealUrl = streaming.buildWebSocketUrl.bind(streaming);
  streaming.buildWebSocketUrl = (options) =>
    buildRealUrl(options).replace("wss://api.deepgram.com/v1/listen", url);
}

test("a warm connection opened for another language is not reused", async () => {
  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
    dialLoopback(streaming, url);

    try {
      // Dictation warms on the UI language: warmupStreamingConnection() runs at
      // startup and after each transcription, before setTranslationRequested()
      // can say a translation wants the source language instead. The URL pins
      // that language — and with it nova-3 vs nova-2 — for the whole session.
      await streaming.warmup({ token: "byok-key", mode: "byok", language: "en" });
      await streaming.connect({ token: "byok-key", mode: "byok", language: "fr" });

      assert.equal(connections.length, 2, "the English warm socket was reused for French");
      assert.match(connections[0], /language=en/);
      assert.match(connections[1], /language=fr/);
    } finally {
      streaming.cleanupAll();
    }
  });

  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
    dialLoopback(streaming, url);

    try {
      const options = { token: "byok-key", mode: "byok", language: "en" };
      await streaming.warmup(options);
      await streaming.connect(options);

      assert.equal(connections.length, 1, "same language rides the warm socket");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("a warm connection opened for other keyterms is not reused", async () => {
  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok", keyterms: ["Whispr"] });
      await streaming.connect({ token: "byok-key", mode: "byok", keyterms: ["Whispr", "Qdrant"] });

      assert.equal(connections.length, 2, "a dictionary edit must reach the socket");
      assert.match(connections[1], /keyterm=Qdrant/);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("a warm connection is reused when the two option sets build the same URL", async () => {
  // buildWebSocketUrl folds "auto" into no language and skips empty keyterms, so
  // the guard has to fold them the same way — otherwise every dictation cold
  // starts and the warm socket stops buying anything.
  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok", language: "auto" });
      await streaming.connect({ token: "byok-key", mode: "byok", keyterms: [] });

      assert.equal(connections.length, 1, "an identical URL must ride the warm socket");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("adopting managed mode is rejected before changing the direct session", async () => {
  const streaming = new DeepgramStreaming();
  assert.throws(() => streaming.adoptMode({ mode: "openwhispr" }), /requires a direct/);
});

test("a BYOK key authenticates under Deepgram's Token scheme", async () => {
  await withMetadataServer(async (url, connections, authHeaders) => {
    const streaming = new DeepgramStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.connect({ token: "byok-key", mode: "byok" });

      assert.deepEqual(authHeaders, ["Token byok-key"]);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("warmup presents the same scheme the session will connect with", async () => {
  await withMetadataServer(async (url, connections, authHeaders) => {
    const streaming = new DeepgramStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok" });

      assert.deepEqual(authHeaders, ["Token byok-key"]);
    } finally {
      streaming.cleanupAll();
    }
  });
});

// Its only consumer is the weekly canary, not PR CI: without this, deleting the
// export stays green for a week.
test("the authorization scheme is exported for the canary to reuse", () => {
  assert.equal(DeepgramStreaming.authorizationHeader("byok", "k"), "Token k");
  assert.equal(DeepgramStreaming.authorizationHeader("openwhispr", "k"), "Token k");
});
