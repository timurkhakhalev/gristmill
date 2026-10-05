const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { EventEmitter } = require("node:events");

const Module = require("node:module");

const createMeetingSystemAudioWatchdog: typeof import("../../src/helpers/meetingSystemAudioWatchdog.ts").createMeetingSystemAudioWatchdog = require("../../src/helpers/meetingSystemAudioWatchdog.ts");

// The tap helper reports a stranded device as a stderr warning rather than by
// exiting, so the forwarding path is the only thing that can tell the main
// process capture has stopped (#1990). Warnings must never settle or fail the
// start handshake either, which is what the mid-handshake test pins.

const managerModulePath = require.resolve("../../src/helpers/audioTapManager.ts");

const originalLoad = Module._load;

type FakeChildLike = {
  stdout: { emit: (e: string, data: unknown) => void };
  stderr: { emit: (e: string, data: unknown) => void };
};

let lastChild: FakeChildLike | null = null;

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
  };

  return child;
}

function loadManagerClass() {
  delete require.cache[managerModulePath];
  Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
    if (request === "child_process") {
      return {
        spawn: () => {
          lastChild = createFakeChild();

          return lastChild;
        },
      };
    }

    if (request === "./debugLogger" || request === "./debugLogger.js") {
      return { info() {}, debug() {}, error() {}, warn() {} };
    }

    return originalLoad(request, parent, isMain);
  };

  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const AudioTapManager = loadManagerClass();

// Same instance-seam style as windowsLoopbackAudioManager.test.js: the binary
// lookup and the macOS version gate are not what is under test here.
function createManager() {
  const manager = new AudioTapManager();
  manager.isSupported = () => true;
  manager._prepareBinary = () => "/fake/macos-audio-tap";

  return manager;
}

const emitLine = (child: FakeChildLike, message: unknown) =>
  child.stderr.emit("data", `${JSON.stringify(message)}\n`);

test("a device_invalidated warning reaches onWarning and not onError", async () => {
  const manager = createManager();
  const warnings: unknown[] = [];
  const errors: unknown[] = [];

  const started = manager.start({
    onChunk: () => {},
    onError: (error: unknown) => errors.push(error),
    onWarning: (warning: unknown) => warnings.push(warning),
  });

  emitLine(lastChild!, { type: "start" });
  await started;

  emitLine(lastChild!, {
    type: "warning",
    code: "device_invalidated",
    reason: "default_output_changed",
    message: "System audio device changed",
  });

  assert.equal(warnings.length, 1);
  assert.equal((warnings[0] as { code: string }).code, "device_invalidated");
  assert.equal((warnings[0] as { reason: string }).reason, "default_output_changed");
  assert.deepEqual(errors, []);
});

test("a warning during the start handshake neither resolves nor rejects it", async () => {
  const manager = createManager();
  const warnings = [];
  let settled = false;

  const started = manager
    .start({ onWarning: (warning: unknown) => warnings.push(warning) })
    .then(() => {
      settled = true;
    });

  const child = lastChild!;
  emitLine(child, { type: "warning", code: "listener_unavailable", message: "no listener" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(warnings.length, 1);
  assert.equal(settled, false, "a warning must not be mistaken for the start acknowledgement");

  emitLine(child, { type: "start" });
  await started;
  assert.equal(settled, true);
});

test("restarting an already-running manager re-points the warning handler", async () => {
  const manager = createManager();
  const first: unknown[] = [];
  const second = [];

  const started = manager.start({ onWarning: (warning: unknown) => first.push(warning) });
  const child = lastChild!;
  emitLine(child, { type: "start" });
  await started;

  // startManagedMeetingSystemAudio calls start() again on the live manager, and
  // the new session's callbacks have to take over from the previous ones.
  await manager.start({ onWarning: (warning: unknown) => second.push(warning) });
  emitLine(child, { type: "warning", code: "device_invalidated", message: "changed" });

  assert.deepEqual(first, []);
  assert.equal(second.length, 1);
});

test("stop drops the warning handler along with the rest of the callbacks", async () => {
  const manager = createManager();
  const warnings: unknown[] = [];

  const started = manager.start({ onWarning: (warning: unknown) => warnings.push(warning) });
  const child = lastChild!;
  emitLine(child, { type: "start" });
  await started;

  await manager.stop();
  assert.equal(manager.onWarning, null);

  emitLine(child, { type: "warning", code: "device_invalidated", message: "changed" });
  assert.deepEqual(warnings, [], "a warning from the dead helper must not reach the new session");
});

test("a device warning beside the replacement start acknowledgement triggers another recovery", async (t: import("node:test").TestContext) => {
  const manager = createManager();
  const interruptions: Array<{ reason: string; recovering: boolean }> = [];

  const watchdog = createMeetingSystemAudioWatchdog({
    onInterrupted: (payload: { reason: string; recovering: boolean }) =>
      interruptions.push(payload),
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const startCapture = () =>
    manager.start({
      onWarning: (warning: unknown) => {
        if ((warning as { code?: string }).code === "device_invalidated")
          watchdog.reportDeviceInvalidated();
      },
    });

  watchdog.attachCapture({ stop: () => manager.stop(), start: startCapture });
  t.after(async () => {
    watchdog.stop();
    await manager.stop();
  });

  const started = startCapture();
  emitLine(lastChild!, { type: "start" });
  await started;
  watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  emitLine(lastChild!, { type: "warning", code: "device_invalidated" });
  await flush();
  await flush();
  const replacement = lastChild!;

  // A busy main process can read both native messages in the same pipe chunk.
  replacement.stderr.emit(
    "data",
    '{"type":"start"}\n{"type":"warning","code":"device_invalidated"}\n'
  );
  await flush();
  await flush();

  assert.notEqual(lastChild, replacement, "the invalidated replacement must be replaced too");
  emitLine(lastChild!, { type: "start" });
  await flush();
  assert.equal(interruptions.length, 2);
  assert.ok(
    interruptions.every(
      (entry: { reason: string; recovering: boolean }) =>
        entry.reason === "device_invalidated" && entry.recovering
    )
  );
});

test("PCM arriving before start waits for its epoch; clock messages never reorder or replace PCM", async (t: import("node:test").TestContext) => {
  const manager = createManager();
  t.after(() => manager.stop());
  const order: string[] = [];
  const chunks: Buffer[] = [];
  const frameStarts: number[] = [];
  const clocks: unknown[] = [];
  const generation = "11111111-1111-4111-8111-111111111111";

  const started = manager.start({
    onStart: () => order.push("epoch"),
    onChunk: (chunk: Buffer, frameStart: number) => {
      order.push("pcm");
      chunks.push(chunk);
      frameStarts.push(frameStart);
    },
    onClock: (clock: unknown) => {
      order.push("clock");
      clocks.push(clock);
    },
  });

  const child = lastChild!;
  child.stdout.emit("data", Buffer.from([1, 2]));
  child.stdout.emit("data", Buffer.from([3, 4]));
  emitLine(child, { type: "pcm", frameStart: 0, frameCount: 1 });
  emitLine(child, { type: "pcm", frameStart: 1, frameCount: 1 });
  emitLine(child, {
    type: "clock",
    generation,
    startFrame: 0,
    endFrame: 2,
    hostStartNs: "100",
    hostEndNs: "200",
    timebaseNumer: 1,
    timebaseDenom: 1,
    conversion: "uncalibrated",
    reason: null,
  });
  assert.deepEqual(chunks, []);
  assert.deepEqual(order, ["clock"]);
  assert.equal(clocks.length, 1);
  emitLine(child, {
    type: "start",
    generation,
    sampleRate: 24_000,
    channels: 1,
    bitsPerChannel: 16,
  });
  await started;
  assert.deepEqual(order, ["clock", "epoch", "pcm", "pcm"]);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(frameStarts, [0, 1]);
});

test("malformed clock metadata reports coverage warning but preserves PCM and ignores retired helper messages", async (t: import("node:test").TestContext) => {
  const manager = createManager();
  t.after(() => manager.stop());
  const warnings: Array<{ code?: string }> = [];
  const chunks: Buffer[] = [];
  const frameStarts: number[] = [];
  const errors: Error[] = [];

  const started = manager.start({
    onChunk: (chunk: Buffer, frameStart: number) => {
      chunks.push(chunk);
      frameStarts.push(frameStart);
    },
    onWarning: (warning: { code?: string }) => warnings.push(warning),
    onError: (error: Error) => errors.push(error),
  });

  const retired = lastChild!;
  emitLine(retired, { type: "start" });
  await started;
  emitLine(retired, { type: "clock", startFrame: 10, endFrame: 0 });
  emitLine(retired, { type: "pcm", frameStart: 0, frameCount: 1 });
  retired.stdout.emit("data", Buffer.from([1, 2]));
  assert.equal(warnings[0].code, "clock_invalid_message");
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], Buffer.from([1, 2]));
  assert.deepEqual(frameStarts, [0]);
  assert.deepEqual(errors, []);
  await manager.stop();
  const restarted = manager.start({ onChunk: (chunk: Buffer) => chunks.push(chunk) });
  emitLine(lastChild!, { type: "start" });
  await restarted;
  retired.stdout.emit("data", Buffer.from([3, 4]));
  assert.equal(chunks.length, 1);
});
