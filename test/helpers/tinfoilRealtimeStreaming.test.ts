const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { EventEmitter }: typeof import("node:events") = require("node:events");
const WS = require("ws");
import type { TinfoilRealtimeStreaming as Streaming } from "../../src/helpers/tinfoilRealtimeStreaming.ts";

const load = () => import("../../src/helpers/tinfoilRealtimeStreaming.ts");
const COMPLETED_EVENT = "conversation.item.input_audio_transcription.completed";

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  readyState: number;

  constructor(readyState: number) {
    super();
    this.readyState = readyState;
  }

  send(data: string | Buffer): void {
    this.sent.push(data.toString());
  }

  ping(): void { this.emit("pong"); }

  terminate(): void {
    this.readyState = WS.CLOSED;
    this.emit("close", 1006, Buffer.from(""));
  }

  close(): void { this.readyState = WS.CLOSED; }
}

function makeFakeSocket(readyState: number): FakeSocket {
  return new FakeSocket(readyState);
}

function makeRecordingFactory(socket: FakeSocket) {
  const calls: { model: string; apiKey: string }[] = [];
  return {
    calls,
    factory: async (args: { model: string; apiKey: string }) => {
      calls.push(args);
      return socket;
    },
  };
}

type SocketEvent =
  | { type: "input_audio_buffer.commit" }
  | { type: "session.update"; session: { audio: { input: {
    format: { type: string; rate: number };
    transcription: { model: string };
    turn_detection: Record<string, unknown> | null;
  } } } };

function sentEvents<T extends SocketEvent["type"]>(socket: FakeSocket | Streaming["ws"], type: T): Extract<SocketEvent, { type: T }>[] {
  assert.ok(socket instanceof FakeSocket);
  return socket.sent.map((raw) => JSON.parse(raw) as SocketEvent)
    .filter((event): event is Extract<SocketEvent, { type: T }> => event.type === type);
}

function completed(transcript: string) {
  return JSON.stringify({ type: COMPLETED_EVENT, transcript });
}

function commitEmptyError() {
  return JSON.stringify({
    type: "error",
    error: { code: "input_audio_buffer_commit_empty", message: "buffer too small" },
  });
}

function speechPcm(sampleCount = 480, amplitude = 2000) {
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index % 2 === 0 ? amplitude : -amplitude;
  }
  return Buffer.from(samples.buffer);
}

async function makeConnected() {
  const { TinfoilRealtimeStreaming } = await load();
  const streaming = new TinfoilRealtimeStreaming();
  streaming.ws = makeFakeSocket(WS.OPEN);
  streaming._markConnected();
  return streaming;
}

async function finishConnect(_streaming: Streaming, socket: FakeSocket, preconfigured = false) {
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  if (!preconfigured) {
    socket.emit("message", JSON.stringify({ type: "session.updated" }));
  }
}

test("connect uses only the attested socket factory with the selected model and key", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory, calls } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);
  let rogueCalled = false;

  const connected = streaming.connect({
    apiKey: "tk-secret",
    model: "custom-rt-model",
    createSocket: async () => {
      rogueCalled = true;
      return makeFakeSocket(WS.OPEN);
    },
  });
  await finishConnect(streaming, socket);
  await connected;

  assert.equal(rogueCalled, false);
  assert.deepEqual(calls, [{ model: "custom-rt-model", apiKey: "tk-secret" }]);
  streaming.cleanup();
});

test("connect defaults to the supported Tinfoil realtime model", async () => {
  const { TinfoilRealtimeStreaming, TINFOIL_REALTIME_MODEL } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory, calls } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);

  const connected = streaming.connect({ apiKey: "tk-secret" });
  await finishConnect(streaming, socket);
  await connected;

  assert.equal(TINFOIL_REALTIME_MODEL, "voxtral-mini-4b-realtime");
  assert.equal(calls[0].model, TINFOIL_REALTIME_MODEL);
  streaming.cleanup();
});

test("connection lifecycle logs name Tinfoil, never OpenAI", async () => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const { TinfoilRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);

  const messages: string[] = [];
  const levels = ["debug", "warn", "error"];
  const originals = Object.fromEntries(levels.map((level) => [level, debugLogger[level]]));
  for (const level of levels) {
    debugLogger[level] = (message: string) => messages.push(message);
  }
  try {
    const connected = streaming.connect({ apiKey: "tk-secret" });
    await finishConnect(streaming, socket);
    await connected;
    await streaming.disconnect();
  } finally {
    for (const level of levels) debugLogger[level] = originals[level];
  }

  assert.ok(
    messages.some((message) => message.startsWith("Tinfoil Realtime")),
    `expected Tinfoil-labelled logs, got: ${JSON.stringify(messages)}`
  );
  assert.deepEqual(
    messages.filter((message) => message.includes("OpenAI")),
    [],
    "a Tinfoil session must never log the OpenAI label"
  );
});

test("the default factory is the pinned Tinfoil transport", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const { createTinfoilRealtimeSocket }: typeof import("../../src/helpers/tinfoilSecureClient") = require("../../src/helpers/tinfoilSecureClient");

  assert.equal(new TinfoilRealtimeStreaming()._createSocketImpl, createTinfoilRealtimeSocket);
});

test("attestation failure rejects without opening a fallback socket", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const streaming = new TinfoilRealtimeStreaming(async () => {
    throw new Error("attestation failed");
  });

  await assert.rejects(() => streaming.connect({ apiKey: "tk-secret" }), /attestation failed/);
  assert.equal(streaming.ws, null);
  assert.equal(streaming.isConnected, false);
});

test("every fresh instance invokes the attested factory", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const calls: { model: string; apiKey: string }[] = [];

  for (let index = 0; index < 2; index += 1) {
    const socket = makeFakeSocket(WS.CONNECTING);
    const streaming = new TinfoilRealtimeStreaming(async (args) => {
      calls.push(args);
      return socket;
    });
    const connected = streaming.connect({ apiKey: "tk-secret" });
    await finishConnect(streaming, socket);
    await connected;
    streaming.cleanup();
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test("meeting sessions declare the 24kHz PCM input format", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);

  const connected = streaming.connect({ apiKey: "tk-secret" });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));

  const [update] = sentEvents(socket, "session.update");
  assert.deepEqual(update.session.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(update.session.audio.input.transcription.model, "voxtral-mini-4b-realtime");
  assert.deepEqual(
    update.session.audio.input.turn_detection,
    { type: "server_vad", threshold: 0.6, silence_duration_ms: 600, prefix_padding_ms: 500 },
    "subclass inherits the base VAD; Phase 1 changes this only when options are passed"
  );

  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;
  streaming.cleanup();
});

test("meeting session.update honors streamLabel + vadThreshold overrides through the subclass", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);

  const connected = streaming.connect({
    apiKey: "tk-secret",
    streamLabel: "system",
    vadThreshold: 0.3,
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));

  const [update] = sentEvents(socket, "session.update");
  assert.deepEqual(update.session.audio.input.turn_detection, {
    type: "server_vad",
    threshold: 0.3,
    silence_duration_ms: 600,
    prefix_padding_ms: 500,
  });
  assert.equal(streaming.streamLabel, "system");

  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;
  streaming.cleanup();
});

test("labelled Tinfoil sessions carry the stream label in log metadata", async () => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const { TinfoilRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);

  const entries: { message: string; meta: Record<string, unknown> }[] = [];
  const levels = ["debug", "warn", "error"];
  const originals = Object.fromEntries(levels.map((level) => [level, debugLogger[level]]));
  for (const level of levels) {
    debugLogger[level] = (message: string, meta: Record<string, unknown>) => entries.push({ message, meta });
  }
  try {
    const connected = streaming.connect({ apiKey: "tk-secret", streamLabel: "system" });
    await finishConnect(streaming, socket);
    await connected;
    await streaming.disconnect();
  } finally {
    for (const level of levels) debugLogger[level] = originals[level];
  }

  const summary = entries.find((entry) => entry.message === "Tinfoil Realtime disconnect");
  assert.ok(summary, "disconnect summary must be logged");
  assert.equal(summary.meta.stream, "system");
  assert.equal(typeof summary.meta.speechStartedCount, "number");
});

test("speech followed by 600ms of PCM silence commits the turn", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    streaming.sendAudio(speechPcm());

    t.mock.timers.tick(500);
    streaming.sendAudio(Buffer.alloc(960));
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 0);

    t.mock.timers.tick(250);
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 1);
  })();
});

test("continuous speech is bounded by a 30-second turn", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();

    for (let index = 0; index < 119; index += 1) {
      streaming.sendAudio(speechPcm());
      t.mock.timers.tick(250);
    }
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 0);

    streaming.sendAudio(speechPcm());
    t.mock.timers.tick(250);
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 1);
  })();
});

test("a silent backend turn is recycled before the provider zombie window", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    streaming.sendAudio(Buffer.alloc(960));

    t.mock.timers.tick(29750);
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 0);
    t.mock.timers.tick(250);
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 1);
  })();
});

test("no audio produces no commits", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    t.mock.timers.tick(60000);
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 0);
  })();
});

test("completed re-arms the next buffered turn", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    const finals: string[] = [];
    streaming.onFinalTranscript = (text: string) => finals.push(text);

    streaming.sendAudio(speechPcm());
    t.mock.timers.tick(750);
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 1);

    streaming.sendAudio(speechPcm());
    t.mock.timers.tick(750);
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 1);

    streaming.handleMessage(completed("first"));
    t.mock.timers.tick(250);
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 2);
    assert.deepEqual(finals, ["first"]);
  })();
});

test("commit timeout requests recovery without sending a duplicate commit", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    const errors: string[] = [];
    streaming.onConnectionLost = (error: Error) => errors.push(error.message);

    streaming.sendAudio(speechPcm());
    t.mock.timers.tick(750);
    t.mock.timers.tick(20250);

    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 1);
    assert.deepEqual(errors, ["Tinfoil did not finish the current transcript segment."]);
  })();
});

test("speech timing comes from PCM activity rather than transcript timing", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();

    streaming.sendAudio(Buffer.alloc(960));
    assert.equal(streaming.speechStartedAt, null);
    t.mock.timers.tick(250);
    streaming.sendAudio(speechPcm());
    assert.equal(streaming.speechStartedAt, 100250);
  })();
});

test("disconnect drains an in-flight commit before committing the tail", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    const socket = streaming.ws;

    streaming.sendAudio(speechPcm());
    t.mock.timers.tick(750);
    streaming.sendAudio(speechPcm());

    const disconnected = streaming.disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentEvents(socket, "input_audio_buffer.commit").length, 1);

    streaming.handleMessage(completed("first"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentEvents(socket, "input_audio_buffer.commit").length, 2);

    streaming.handleMessage(completed("tail"));
    assert.deepEqual(await disconnected, { text: "first tail" });
  })();
});

test("disconnect remains bounded when the provider never completes", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    streaming.sendAudio(speechPcm());
    t.mock.timers.tick(750);

    const disconnected = streaming.disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(3000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(await disconnected, { text: "" });
  })();
});

test("disconnect uses one drain deadline across the active turn and its tail", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    const socket = streaming.ws;
    streaming.sendAudio(speechPcm());
    t.mock.timers.tick(750);
    streaming.sendAudio(speechPcm());

    let finished = false;
    const disconnected = streaming.disconnect().then((result) => {
      finished = true;
      return result;
    });

    t.mock.timers.tick(2000);
    streaming.handleMessage(completed("first"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentEvents(socket, "input_audio_buffer.commit").length, 2);

    t.mock.timers.tick(999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);

    t.mock.timers.tick(1);
    assert.deepEqual(await disconnected, { text: "first" });
  })();
});

test("empty commit replies are swallowed without a retry loop", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    let surfaced = 0;
    streaming.onError = () => {
      surfaced += 1;
    };

    streaming.sendAudio(speechPcm());
    t.mock.timers.tick(750);
    streaming.handleMessage(commitEmptyError());
    t.mock.timers.tick(5000);

    assert.equal(surfaced, 0);
    assert.equal(sentEvents(streaming.ws, "input_audio_buffer.commit").length, 1);
  })();
});

test("provider errors surface and request connection recovery", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    const errors: string[] = [];
    const recoveries: string[] = [];
    streaming.onError = (error: Error) => errors.push(error.message);
    streaming.onConnectionLost = (error: Error) => recoveries.push(error.message);

    streaming.sendAudio(speechPcm());
    t.mock.timers.tick(750);
    streaming.handleMessage(
      JSON.stringify({ type: "error", error: { code: "server_error", message: "failed" } })
    );

    assert.deepEqual(errors, ["failed"]);
    assert.deepEqual(recoveries, ["failed"]);
  })();
});

test("cleanup stops the turn timer", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    const socket = streaming.ws;
    streaming.sendAudio(speechPcm());
    streaming.cleanup();

    t.mock.timers.tick(5000);
    assert.equal(streaming._commitTimer, null);
    assert.equal(sentEvents(socket, "input_audio_buffer.commit").length, 0);
  })();
});
