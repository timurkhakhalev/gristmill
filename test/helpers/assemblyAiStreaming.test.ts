const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming.ts");
const { deferred }: typeof import("./harness/deferred.ts") = require("./harness/deferred.ts");

type AaiStreaming = InstanceType<typeof AssemblyAiStreaming> & { buildWebSocketUrl: (options?: unknown) => string; onAudioFrame?: (cb: unknown) => void };
async function withPrematureCloseServer(run: (url: string) => Promise<void>) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket: { close: (code: number, reason: string) => void }) => {
    socket.close(1008, "rejected before Begin");
  });

  try {
    await run(`ws://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// `connections` collects each accepted request URL so a test can count sockets
// and read the query the client actually sent. `onAudioFrame` reports each
// binary frame the server receives.
async function withBeginServer(run: (url: string, connections: string[]) => Promise<void>, { onAudioFrame }: { onAudioFrame?: (data: Buffer) => void } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const connections: string[] = [];
  server.on("connection", (socket: unknown, request: { url: string }) => {
    connections.push(request.url);
    const ws = socket as { on: (event: string, cb: (data: Buffer, isBinary: boolean) => void) => void; send: (data: string) => void };
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) onAudioFrame?.(data);
    });
    ws.send(JSON.stringify({ type: "Begin", id: "test-session" }));
  });

  try {
    await run(`ws://127.0.0.1:${(server.address() as { port: number }).port}`, connections);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Keeps the real query string (speech_model, token) while dialing the loopback server.
function dialLoopback(streaming: AaiStreaming, url: string) {
  const buildRealUrl = streaming.buildWebSocketUrl.bind(streaming);
  streaming.buildWebSocketUrl = (options?: unknown) =>
    buildRealUrl(options).replace("wss://streaming.assemblyai.com/v3/ws", url);
}

test("warmup rejects when the socket closes before Begin", async () => {
  await withPrematureCloseServer(async (url: string) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await assert.rejects(
        () => streaming.warmup({ token: "test-token", mode: "byok" }),
        /closed.*1008/i
      );
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("connect rejects when the socket closes before Begin", async () => {
  await withPrematureCloseServer(async (url: string) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await assert.rejects(
        () => streaming.connect({ token: "test-token", mode: "byok" }),
        /closed.*1008/i
      );
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("warmup resolves when the server sends Begin", async () => {
  await withBeginServer(async (url: string) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.warmup({ token: "test-token", mode: "byok" });

      assert.equal(streaming.hasWarmConnection(), true);
      assert.equal(streaming.warmSessionId, "test-session");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("connect resolves when the server sends Begin", async () => {
  await withBeginServer(async (url: string) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.connect({ token: "test-token", mode: "byok" });

      assert.equal(streaming.isConnected, true);
      assert.equal(streaming.sessionId, "test-session");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("managed mode is rejected before opening a socket", async () => {
  const streaming = new AssemblyAiStreaming();
  await assert.rejects(
    () => streaming.warmup({ token: "managed-token", mode: "openwhispr" }),
    /requires a direct provider API key/
  );
});

test("Turn fixtures preserve partial, final, and formatted replacement callbacks", () => {
  const streaming = new AssemblyAiStreaming();
  const partials: unknown[] = [];
  const finals: unknown[] = [];
  streaming.onPartialTranscript = (text: string) => partials.push(text);
  streaming.onFinalTranscript = (text: string, startedAt: number) => finals.push({ text, startedAt });

  streaming.handleMessage(Buffer.from("{"));
  streaming.handleMessage(
    Buffer.from(JSON.stringify({ type: "Turn", transcript: { malformed: true } }))
  );
  streaming.handleMessage(
    Buffer.from(JSON.stringify({ type: "Turn", transcript: "Hello", end_of_turn: false }))
  );
  streaming.speechStartedAt = 1_000;
  streaming.handleMessage(
    Buffer.from(JSON.stringify({ type: "Turn", transcript: "Hello.", end_of_turn: true }))
  );
  streaming.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "Turn",
        transcript: "Hello!",
        end_of_turn: true,
        turn_is_formatted: true,
      })
    )
  );

  assert.deepEqual(partials, ["Hello"]);
  assert.deepEqual(finals, [
    { text: "Hello.", startedAt: 1_000 },
    { text: "Hello!", startedAt: 1_000 },
  ]);
  assert.deepEqual(streaming.completedSegments, ["Hello!"]);
});

test("a warm connection opened for another speech model is not reused", async () => {
  await withBeginServer(async (url: string, connections) => {
    const streaming = new AssemblyAiStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({
        token: "byok-key",
        mode: "byok",
        model: "universal-streaming-english",
      });
      // The server pins speech_model at Begin; reusing this socket would keep the
      // warm model for the whole session and hide the downgrade from the user.
      await streaming.connect({ token: "byok-key", mode: "byok", model: "universal-3-5-pro" });

      assert.equal(connections.length, 2);
      assert.match(connections[0], /speech_model=universal-streaming-english/);
      assert.match(connections[1], /speech_model=universal-3-5-pro/);
      assert.equal(streaming.requestedModel, "universal-3-5-pro");
    } finally {
      streaming.cleanupAll();
    }
  });

  await withBeginServer(async (url: string, connections) => {
    const streaming = new AssemblyAiStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok", model: "universal-3-5-pro" });
      await streaming.connect({ token: "byok-key", mode: "byok", model: "universal-3-5-pro" });

      assert.equal(connections.length, 1, "same model rides the warm socket");
    } finally {
      streaming.cleanupAll();
    }
  });
});

// Note Recording's MEETING_STREAM_SAMPLE_RATE (#2140).
const MEETING_SAMPLE_RATE = 24000;
const frameDurationMs = (bytes: number) => (bytes / 2 / MEETING_SAMPLE_RATE) * 1000;

// node:test has no default timeout, so the wait is bounded here: withheld audio
// must fail the run rather than hang it.
async function collectFrames(chunks: number[], assertFrames: (frames: number[]) => void) {
  const frames: number[] = [];
  let receivedBytes = 0;
  const allReceived = deferred();
  const expectedBytes = chunks.reduce((total: number, bytes: number) => total + bytes, 0);

  await withBeginServer(
    async (url: string, connections: string[]) => {
      const streaming = new AssemblyAiStreaming();
      // The real builder is what pins the session's sample rate: do not stub it.
      dialLoopback(streaming, url);

      try {
        await streaming.connect({
          token: "byok-key",
          mode: "byok",
          sampleRate: MEETING_SAMPLE_RATE,
        });
        for (const bytes of chunks) streaming.sendAudio(Buffer.alloc(bytes));
        await Promise.race([
          allReceived.promise,
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`only ${receivedBytes} of ${expectedBytes} bytes reached the server`)
                ),
              2000
            ).unref()
          ),
        ]);

        assert.match(
          connections[0],
          /sample_rate=24000/,
          "the session must open at the meeting rate for the frame maths to mean anything"
        );
        assertFrames(frames);
      } finally {
        streaming.cleanupAll();
      }
    },
    {
      onAudioFrame: (data: Buffer) => {
        frames.push(data.length);
        receivedBytes += data.length;
        if (receivedBytes >= expectedBytes) allReceived.resolve();
      },
    }
  );
}

test("audio frames respect AssemblyAI's 50 ms floor at the meeting sample rate", async () => {
  // 480 bytes is one 10 ms PCM16 frame at a 24 kHz meeting capture rate.
  await collectFrames(Array(20).fill(480), (frames) => {
    assert.ok(frames.length > 0, "no audio reached the server");
    for (const bytes of frames) {
      assert.ok(
        frameDurationMs(bytes) >= 50,
        `sent a ${frameDurationMs(bytes).toFixed(1)} ms frame; AssemblyAI's floor is 50 ms`
      );
    }
  });
});

test("a coalesced system-audio read is split inside AssemblyAI's frame window", async () => {
  // A stalled main process gets one 64 KB pipe read off the system-audio helper:
  // 1365 ms at 24 kHz, which AssemblyAI rejects like an undersized frame. The
  // slices target the documented 250 ms ceiling, not the 1000 ms hard limit.
  await collectFrames([65536], (frames) => {
    assert.ok(frames.length > 1, "a 1365 ms read must be split, not sent whole");
    for (const bytes of frames) {
      assert.ok(
        frameDurationMs(bytes) >= 50 && frameDurationMs(bytes) <= 250,
        `sent a ${frameDurationMs(bytes).toFixed(1)} ms frame; AssemblyAI documents 50-250 ms`
      );
    }
  });
});

test("a sub-floor remainder is carried into the next frame, not dropped", async () => {
  // 50000 B leaves 2000 B after the slices — under the 2400 B floor at 24 kHz, so
  // it can only go out once the next chunk lifts it over. Without the carry it is
  // silently discarded and 2000 B of speech never reaches the transcript, which
  // collectFrames catches as bytes that never arrive. Asserting the tail rather
  // than the whole shape keeps this independent of MAX_FRAME_MS.
  await collectFrames([50000, 2400], (frames) => {
    assert.equal(frames.at(-1), 4400, "the 2000 B tail must ride out on the next frame");
  });
});

test("a warm connection opened at another sample rate is not reused", async () => {
  await withBeginServer(async (url: string, connections) => {
    const streaming = new AssemblyAiStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok" });
      // The rate is pinned at open, so riding a 16 kHz warm socket with 24 kHz PCM
      // garbles the transcript silently and re-frames audio against the wrong rate.
      await streaming.connect({
        token: "byok-key",
        mode: "byok",
        sampleRate: MEETING_SAMPLE_RATE,
      });

      assert.equal(connections.length, 2);
      assert.match(connections[0], /sample_rate=16000/);
      assert.match(connections[1], /sample_rate=24000/);
      assert.equal(streaming.sessionSampleRate, MEETING_SAMPLE_RATE);
    } finally {
      streaming.cleanupAll();
    }
  });

  await withBeginServer(async (url: string, connections) => {
    const streaming = new AssemblyAiStreaming();
    dialLoopback(streaming, url);

    try {
      const options = { token: "byok-key", mode: "byok", sampleRate: MEETING_SAMPLE_RATE };
      await streaming.warmup(options);
      await streaming.connect(options);

      assert.equal(connections.length, 1, "same rate rides the warm socket");
    } finally {
      streaming.cleanupAll();
    }
  });
});
