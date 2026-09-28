const test: typeof import("node:test") = require("node:test");
const { afterEach }: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter }: typeof import("node:events") = require("node:events");
const childProcess = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");

const detectorModulePath = require.resolve("../../src/helpers/audioActivityDetector.ts");

type ExecResponse = { stdout?: string; stderr?: string; error?: Error; promise?: Promise<unknown> };
interface DetectorOptions { excludedProcessIds?: () => number[]; ownPids?: number[]; execResponses?: ExecResponse[]; spawnError?: string; isMeetingAppRunning?: (name: string) => boolean | Promise<boolean>; }
type LogEntry = { message: unknown; data?: unknown };
// Private members cannot enter an intersection (it collapses to never), so the
// under-test view redeclares the shape the tests actually touch.
type DetectorUnderTest = import("node:events").EventEmitter & {
  start: () => Promise<void>;
  stop: () => void;
  hasPrompted: boolean;
  _isMicActive?: () => Promise<boolean>;
  _activeMicPids: Set<number>;
  _eventDriven: boolean;
  checkInterval?: ReturnType<typeof setInterval> | null;
  _listenerProcess?: FakeChild | null;
  _sustainedTimer?: ReturnType<typeof setTimeout> | null;
  _lastKnownMicState: boolean;
  _pauseAutomaticPrompts: () => void;
  getExternalMicState: () => unknown;
  setUserRecording: (active: boolean) => void;
  setMicWarmHold: (active: boolean) => void;
  notifyMeetingAppsChanged: () => void;
  dismiss: () => void;
  resetPrompt: () => void;
  on: (event: string, listener: (...args: never[]) => void) => import("node:events").EventEmitter;
};
type FakeChild = import("node:events").EventEmitter & { stdout: import("node:events").EventEmitter; stderr: import("node:events").EventEmitter; killed: boolean; kill: (signal?: string) => boolean };
const originalLoad = Module._load;
const originalPlatform = process.platform;

// The detector reads process.platform both at load time (poll interval) and at
// start() time (listener selection), so it stays pinned for the whole test.
function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => setPlatform(originalPlatform));

function loadDetector(platform: string, spawn: (command: string, args: string[], options: unknown) => FakeChild, exec: unknown, logEntries: LogEntry[]) {
  delete require.cache[detectorModulePath];
  setPlatform(platform);

  Module._load = function loadWithMocks(this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (request === "./debugLogger" || request === "./debugLogger.js") {
      return {
        info(message: unknown, data?: unknown) {
          logEntries.push({ message, data });
        },
        warn() {},
        debug() {},
        error() {},
      };
    }
    if (request === "child_process") {
      return { ...childProcess, exec, spawn };
    }
    // Binary resolution hits the real filesystem, so without this the platform
    // under test would be decided by which listener binaries happen to be built
    // on the host rather than by setPlatform().
    if (request === "./binaryResolver" || request === "./binaryResolver.js") {
      return { resolveBundledBinary: (name: string) => `/fake/bin/${name}` };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(detectorModulePath) as unknown as new (getExcluded: () => number[], isMeetingAppRunning?: (name: string) => boolean | Promise<boolean>) => DetectorUnderTest;
  } finally {
    Module._load = originalLoad;
  }
}

// Mirrors child_process: "spawn" and "error" are both delivered on the nextTick
// queue, which drains before the promise microtasks awaiting start().
function createFakeChild(spawnError?: string): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    process.nextTick(() => child.emit("exit", null));
    return true;
  };
  process.nextTick(() => {
    if (spawnError) child.emit("error", new Error(spawnError));
    else child.emit("spawn");
  });
  return child;
}

// `ownPids` is the #1392 spelling of the same injection: outside Electron the
// real provider can only see the main pid, so child-process PIDs are supplied
// here. Both spellings feed the detector's excluded-pid provider.
function createDetector(
  platform: string,
  { excludedProcessIds, ownPids, execResponses = [], spawnError, isMeetingAppRunning }: DetectorOptions = {}
) {
  const getExcludedProcessIds =
    excludedProcessIds ?? (ownPids ? () => [...ownPids] : () => [process.pid]);
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const execCalls: Array<{ command: string; options: unknown }> = [];
  const logEntries: LogEntry[] = [];
  const fakeExec = (() => {}) as (() => void) & Record<PropertyKey, unknown>;
  fakeExec[Symbol.for("nodejs.util.promisify.custom")] = async (command: string, options: unknown) => {
    execCalls.push({ command, options });
    const response = execResponses.shift();
    if (!response || response.error) {
      throw response?.error || new Error("exec unavailable in test");
    }
    if (response.promise) {
      return response.promise;
    }
    return { stdout: response.stdout, stderr: response.stderr || "" };
  };
  const AudioActivityDetector = loadDetector(
    platform,
    (command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      const child = createFakeChild(spawnError);
      children.push(child);
      return child;
    },
    fakeExec,
    logEntries
  );

  const detector = new AudioActivityDetector(getExcludedProcessIds, isMeetingAppRunning);
  detector._isMicActive = async () => false;
  return { detector, children, calls, execCalls, logEntries };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// flush() pends on the mocked setTimeout, so mock-timer tests drain the
// reconcile promise chain through the unmocked immediate queue instead.
const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));
const PLATFORMS = ["darwin"];

for (const platform of PLATFORMS) {
  test(`${platform}: a listener that fails to launch uses only a safe fallback`, async (t: import("node:test").TestContext) => {
    const { detector } = createDetector(platform, { spawnError: "spawn ENOENT" });
    t.after(() => detector.stop());

    await detector.start();

    assert.equal(detector._eventDriven, false);
    if (platform === "darwin") {
      assert.equal(detector.checkInterval, undefined, "device-wide polling cannot attribute mic use");
    } else {
      assert.notEqual(detector.checkInterval, null, "polling must take over");
    }
    detector.stop();
  });

  test(`${platform}: a listener that launches stays event-driven`, async () => {
    const { detector, children } = createDetector(platform);

    await detector.start();

    assert.equal(detector._eventDriven, true);
    assert.equal(detector.checkInterval, undefined, "polling must not run alongside a listener");
    detector.stop();
    assert.equal(children[0].killed, true, "stop() must kill the listener");
  });

  test(`${platform}: stop() during launch kills the listener and starts nothing`, async () => {
    const { detector, children } = createDetector(platform);

    const starting = detector.start();
    detector.stop();
    await starting;
    await flush();

    assert.equal(detector._eventDriven, false);
    assert.equal(detector.checkInterval, undefined);
    assert.equal(children[0].killed, true, "the orphaned listener must be killed");
  });

  test(`${platform}: restarting does not orphan the previous listener`, async () => {
    const { detector, children } = createDetector(platform);

    await detector.start();
    detector.stop();
    await detector.start();
    await flush();

    assert.equal(children.length, 2);
    assert.equal(children[0].killed, true, "the first listener must be killed");
    assert.equal(detector._listenerProcess, children[1], "the live listener must be tracked");
    assert.equal(detector.checkInterval, undefined, "a dead listener must not trigger polling");

    detector.stop();
    assert.equal(children[1].killed, true, "the second listener must be killed");
  });

  test(`${platform}: listener output after stop() cannot emit a detection`, async () => {
    const { detector, children } = createDetector(platform);
    let emitted = false;
    detector.on("sustained-audio-detected", () => (emitted = true));

    await detector.start();
    detector.stop();
    children[0].stdout.emit("data", "MIC_ACTIVE\nEvent 'new' on source-output #1\nMIC_START 42\n");
    await flush();

    assert.equal(emitted, false);
    assert.equal(detector._sustainedTimer, null);
  });
}

test("darwin: attributed microphone transitions drive the sustained timer", async () => {
  const { detector, children } = createDetector("darwin");

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  assert.notEqual(detector._sustainedTimer, null);

  children[0].stdout.emit("data", "MIC_STOP 900\n");
  assert.equal(detector._sustainedTimer, null);
  detector.stop();
});


test("darwin: PID events exclude current OpenWhispr processes and continue during recording", async () => {
  let excludedProcessIds = [101, 102];
  const { detector, children } = createDetector("darwin", {
    excludedProcessIds: () => excludedProcessIds,
  });
  const externalStates: unknown[] = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  detector.setUserRecording(true);
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 101\nMIC_START 201\n");
  children[0].stdout.emit("data", "MIC_START 202\nMIC_STOP 201\n");

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: true,
  });
  assert.deepEqual(externalStates, [
    { reliable: true, externalMicActive: false },
    { reliable: true, externalMicActive: true },
  ]);
  assert.equal(detector._sustainedTimer, null, "recording must still suppress meeting prompts");
  assert.deepEqual([...(detector._activeMicPids ?? new Set<number>())], [202], "own pids never enter the set");

  // The exclusion list is read live: a helper that spawned after start() is
  // excluded from its first MIC_START.
  excludedProcessIds = [101, 102, 103];
  children[0].stdout.emit("data", "MIC_START 103\nMIC_STOP 202\n");

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: true,
    externalMicActive: false,
  });
  assert.deepEqual([...detector._activeMicPids], []);
  assert.deepEqual(externalStates, [
    { reliable: true, externalMicActive: false },
    { reliable: true, externalMicActive: true },
    { reliable: true, externalMicActive: false },
  ]);
  detector.stop();
});

test("darwin: aggregate playback cannot prompt without a running meeting app, even after gates lift", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  t.after(() => detector.stop());
  const externalStates: unknown[] = [];
  const detections: unknown[] = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));
  detector.on("sustained-audio-detected", (data) => detections.push(data));

  await detector.start();
  detector.setUserRecording(true);
  detector.dismiss();
  children[0].stdout.emit("data", "CAPABILITY AGGREGATE\nMIC_ACTIVE\n");
  detector.setUserRecording(false);
  t.mock.timers.tick(COOLDOWN_MS);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.deepEqual(detector.getExternalMicState(), {
    reliable: false,
    externalMicActive: false,
  });
  assert.deepEqual(externalStates, []);
  assert.deepEqual(detections, []);
  assert.equal(detector._sustainedTimer, null);
  detector.stop();
});

test("darwin: losing PID capability cancels pending prompts and discards stale ownership", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  t.after(() => detector.stop());
  const externalStates: unknown[] = [];
  const detections: unknown[] = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));
  detector.on("sustained-audio-detected", (data) => detections.push(data));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\nCAPABILITY AGGREGATE\n");
  children[0].stdout.emit("data", "MIC_ACTIVE\nMIC_START 901\n");
  t.mock.timers.tick(SUSTAINED_MS);

  assert.deepEqual(externalStates.at(-1), {
    reliable: false,
    externalMicActive: false,
  });
  assert.deepEqual(detections, []);
  assert.equal(detector._activeMicPids.size, 0);

  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 902\n");
  t.mock.timers.tick(SUSTAINED_MS);
  assert.equal(detections.length, 1, "an attributed call must be detected after recovery");
  children[0].stdout.emit("data", "MIC_STOP 902\n");
  assert.deepEqual(detector.getExternalMicState(), { reliable: true, externalMicActive: false });
  detector.stop();
});

test("darwin: listener exit emits reliability loss and cancels pending audio prompts", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  t.after(() => detector.stop());
  const externalStates: unknown[] = [];
  const detections: unknown[] = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));
  detector.on("sustained-audio-detected", (data) => detections.push(data));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  children[0].emit("exit", 1);
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 901\n");
  t.mock.timers.tick(SUSTAINED_MS);

  assert.deepEqual(externalStates.at(-1), {
    reliable: false,
    externalMicActive: false,
  });
  assert.deepEqual(detections, []);
  assert.equal(detector.checkInterval, undefined);
  detector.stop();
});

test("darwin: output from a replaced listener cannot downgrade the current microphone owner", async (t: import("node:test").TestContext) => {
  const { detector, children } = createDetector("darwin");
  t.after(() => detector.stop());
  await detector.start();
  detector.stop();
  await detector.start();
  children[1].stdout.emit("data", "CAPABILITY PID\nMIC_START 902\n");
  children[0].stdout.emit("data", "CAPABILITY AGGREGATE\nMIC_INACTIVE\n");
  assert.deepEqual(detector.getExternalMicState(), { reliable: true, externalMicActive: true });
  assert.deepEqual([...detector._activeMicPids], [902]);
});

test("darwin: legacy aggregate messages cannot start an audio prompt", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  t.after(() => detector.stop());
  const detections: unknown[] = [];
  detector.on("sustained-audio-detected", (data) => detections.push(data));
  await detector.start();
  children[0].stdout.emit("data", "MIC_ACTIVE\nMIC_START 900\n");
  t.mock.timers.tick(SUSTAINED_MS);
  assert.deepEqual(detections, []);
  assert.equal(detector._activeMicPids.size, 0);
});

test("macOS never polls unrelated audio engines for microphone ownership", () => {
  const { detector, execCalls } = createDetector("darwin");
  detector._pauseAutomaticPrompts();
  assert.equal(detector.checkInterval, undefined);
  assert.deepEqual(execCalls, []);
});

test("darwin: capability changes are logged at info level", async (t: import("node:test").TestContext) => {
  const { detector, children, logEntries } = createDetector("darwin");
  t.after(() => detector.stop());
  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nCAPABILITY AGGREGATE\n");
  assert.deepEqual(
    logEntries.filter(({ message }) => message === "macOS microphone detection capability"),
    [
      { message: "macOS microphone detection capability", data: { capability: "PID" } },
      { message: "macOS microphone detection capability", data: { capability: "AGGREGATE" } },
    ]
  );
});

test("darwin: aggregate activity prompts once a running meeting app corroborates it", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin", { isMeetingAppRunning: () => true });
  t.after(() => detector.stop());
  const detections: unknown[] = [];
  detector.on("sustained-audio-detected", (data) => detections.push(data));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY AGGREGATE\nMIC_ACTIVE\n");
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(detections.length, 1);
  assert.equal((detections[0] as { attributed: boolean }).attributed, false);
  assert.deepEqual(detector.getExternalMicState(), { reliable: false, externalMicActive: false });

  children[0].stdout.emit("data", "MIC_INACTIVE\n");
  assert.equal(detector._sustainedTimer, null);
});

test("darwin: a meeting app launching during aggregate activity is re-evaluated", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let meetingAppRunning = false;
  const { detector, children } = createDetector("darwin", {
    isMeetingAppRunning: () => meetingAppRunning,
  });
  t.after(() => detector.stop());
  const detections: unknown[] = [];
  detector.on("sustained-audio-detected", (data) => detections.push(data));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY AGGREGATE\nMIC_ACTIVE\n");
  t.mock.timers.tick(SUSTAINED_MS);
  assert.deepEqual(detections, [], "device activity alone is not a meeting");

  meetingAppRunning = true;
  detector.notifyMeetingAppsChanged();
  t.mock.timers.tick(SUSTAINED_MS);
  assert.equal(detections.length, 1, "the running meeting app corroborates the live device");
  assert.equal((detections[0] as { attributed: boolean }).attributed, false);
});

test("darwin: a meeting app quitting before the sustained window cancels the aggregate prompt", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let meetingAppRunning = true;
  const { detector, children } = createDetector("darwin", {
    isMeetingAppRunning: () => meetingAppRunning,
  });
  t.after(() => detector.stop());
  const detections: unknown[] = [];
  detector.on("sustained-audio-detected", (data) => detections.push(data));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY AGGREGATE\nMIC_ACTIVE\n");
  meetingAppRunning = false;
  t.mock.timers.tick(SUSTAINED_MS);

  assert.deepEqual(detections, []);
  assert.equal(detector.hasPrompted, false, "an uncorroborated edge must not consume the prompt");
});

test("darwin: attributed transitions prompt without a running meeting app", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin", { isMeetingAppRunning: () => false });
  t.after(() => detector.stop());
  const detections: unknown[] = [];
  detector.on("sustained-audio-detected", (data) => detections.push(data));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(detections.length, 1);
  assert.equal((detections[0] as { attributed: boolean }).attributed, true);
});

test("darwin: regaining PID capability discards unattributed aggregate state", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let meetingAppRunning = false;
  const { detector, children } = createDetector("darwin", {
    isMeetingAppRunning: () => meetingAppRunning,
  });
  t.after(() => detector.stop());
  const detections: unknown[] = [];
  detector.on("sustained-audio-detected", (data) => detections.push(data));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY AGGREGATE\nMIC_ACTIVE\nCAPABILITY PID\n");
  meetingAppRunning = true;
  detector.notifyMeetingAppsChanged();
  t.mock.timers.tick(SUSTAINED_MS);

  assert.deepEqual(detections, [], "the PID transitions that follow are the only evidence");
  assert.equal(detector._lastKnownMicState, false);
});

test("darwin: a crashed listener is respawned with backoff and attributed detection resumes", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  t.after(() => detector.stop());
  const detections: unknown[] = [];
  detector.on("sustained-audio-detected", (data) => detections.push(data));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  children[0].emit("exit", 1);
  assert.equal(children.length, 1, "the respawn must wait for the backoff delay");

  t.mock.timers.tick(RESPAWN_MS);
  await flushImmediate();
  assert.equal(children.length, 2);
  assert.equal(detector._eventDriven, true);

  children[1].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  t.mock.timers.tick(SUSTAINED_MS);
  assert.equal(detections.length, 1);
  assert.deepEqual(detector.getExternalMicState(), { reliable: true, externalMicActive: true });
});

test("darwin: repeated listener crashes back off exponentially", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  t.after(() => detector.stop());

  await detector.start();
  children[0].emit("exit", 1);
  t.mock.timers.tick(RESPAWN_MS);
  await flushImmediate();
  assert.equal(children.length, 2);

  children[1].emit("exit", 1);
  t.mock.timers.tick(RESPAWN_MS);
  await flushImmediate();
  assert.equal(children.length, 2, "the second retry must wait twice as long");
  t.mock.timers.tick(RESPAWN_MS);
  await flushImmediate();
  assert.equal(children.length, 3);
});

test("darwin: stop() cancels a pending listener respawn", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  t.after(() => detector.stop());

  await detector.start();
  children[0].emit("exit", 1);
  detector.stop();
  // The stale timer would fire inside the restart's spawn window, when no
  // listener is registered yet, and launch a duplicate.
  const restarted = detector.start();
  t.mock.timers.tick(RESPAWN_MS * 64);
  await restarted;
  await flushImmediate();

  assert.equal(children.length, 2, "only the restart may spawn a listener");
});

test("darwin: a listener that fails to launch is not respawned", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin", { spawnError: "spawn ENOENT" });
  t.after(() => detector.stop());

  await detector.start();
  t.mock.timers.tick(RESPAWN_MS * 64);
  await flushImmediate();

  assert.equal(children.length, 1);
});

test("darwin: exclusion-provider failure emits reliability loss", async () => {
  let providerFails = false;
  const { detector, children } = createDetector("darwin", {
    excludedProcessIds: () => {
      if (providerFails) throw new Error("metrics unavailable");
      return [process.pid];
    },
  });
  const externalStates: unknown[] = [];
  detector.on("external-mic-state-changed", (state) => externalStates.push(state));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  providerFails = true;
  children[0].stdout.emit("data", "MIC_START 901\n");

  assert.deepEqual(externalStates.at(-1), {
    reliable: false,
    externalMicActive: false,
  });
  detector.stop();
});

test("darwin: native snapshots exclude background speech while preserving meeting capture", async (t: import("node:test").TestContext) => {
  if (originalPlatform !== "darwin") {
    t.skip("the native microphone listener requires macOS");
    return;
  }

  const compiler = childProcess.spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (compiler.error?.code === "ENOENT" || compiler.status !== 0) {
    t.skip("no Swift compiler is available for the native-state test");
    return;
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-mac-mic-listener-"));
  const executablePath = path.join(temporaryDirectory, "mic-listener-state-test");
  t.after(() => fs.rmSync(temporaryDirectory, { force: true, recursive: true }));

  const compileResult = childProcess.spawnSync(
    "swiftc",
    [
      "-D",
      "MIC_LISTENER_STATE_TEST",
      path.resolve(__dirname, "../../resources/macos-mic-listener.swift"),
      "-framework",
      "CoreAudio",
      "-framework",
      "Foundation",
      "-o",
      executablePath,
    ],
    // Filling Swift's compiler-managed module cache can exceed a tight timeout.
    { encoding: "utf8", timeout: 600_000 }
  );
  assert.equal(compileResult.status, 0, compileResult.error?.message || compileResult.stderr);

  const coreSpeech = {
    objectID: 1,
    pid: 101,
    inputRunning: true,
    bundleID: "com.apple.CoreSpeech",
  };
  const browser = { objectID: 2, pid: 102, inputRunning: true, bundleID: "com.google.Chrome" };
  const unknown = { objectID: 3, pid: 103, inputRunning: true, bundleID: null };
  const scenarios = [
    {
      name: "playback alone keeps PID monitoring available without active meeting capture",
      processes: [coreSpeech],
      expected: { pids: [101], active: [] },
    },
    {
      name: "browser calls and unknown processes survive concurrent background speech",
      processes: [coreSpeech, browser, unknown],
      expected: { pids: [101, 102, 103], active: [102, 103] },
    },
    {
      name: "native meeting apps survive concurrent background speech",
      processes: [coreSpeech, { ...browser, bundleID: "us.zoom.xos" }],
      expected: { pids: [101, 102], active: [102] },
    },
    {
      name: "other Apple apps remain eligible",
      processes: [{ ...browser, bundleID: "com.apple.Safari" }],
      expected: { pids: [102], active: [102] },
    },
    {
      name: "an inactive browser is not meeting capture",
      processes: [{ ...browser, inputRunning: false }],
      expected: { pids: [102], active: [] },
    },
    {
      name: "vanished process objects do not hide a live browser call",
      processes: [{ ...coreSpeech, pid: null }, browser, { ...unknown, inputRunning: null }],
      expected: { pids: [102], active: [102] },
    },
    {
      name: "no processes is a valid idle snapshot",
      processes: [],
      expected: { pids: [], active: [] },
    },
    {
      name: "no readable process objects still signals systemic failure",
      processes: [
        { ...coreSpeech, pid: null },
        { ...browser, inputRunning: null },
      ],
      expected: null,
    },
  ];

  for (const { name, processes, expected } of scenarios) {
    await t.test(name, () => {
      const result = childProcess.spawnSync(executablePath, [JSON.stringify(processes)], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    });
  }

  // Aggregate mode is entered on transient snapshot failures too, so the
  // heartbeat retries PID monitoring; the JS side already accepts a later
  // CAPABILITY PID.
  const recoveryScenarios = [
    {
      name: "a successful retry re-announces PID capability and the live captures",
      fixture: { startSucceeds: true, activePids: [102, 101] },
      expected: { lines: ["CAPABILITY PID", "MIC_START 101", "MIC_START 102"], mode: "process" },
    },
    {
      name: "a failed retry stays in aggregate mode without emitting anything",
      fixture: { startSucceeds: false, activePids: [] },
      expected: { lines: [], mode: "aggregate" },
    },
  ];
  for (const { name, fixture, expected } of recoveryScenarios) {
    await t.test(name, () => {
      const result = childProcess.spawnSync(
        executablePath,
        ["--recover-from-aggregate", JSON.stringify(fixture)],
        { encoding: "utf8", timeout: 5000 }
      );
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      const lines = result.stdout.trim().split("\n");
      const summary = JSON.parse(lines.pop());
      assert.deepEqual({ lines, mode: summary.mode }, expected);
    });
  }
});

// The native listeners are edge-triggered: they emit only on state transitions,
// so an edge swallowed by a gate is never re-delivered. The detector must
// remember the last known state and re-evaluate it when the gate lifts.
// Mirrors SUSTAINED_EVENT_DRIVEN_MS and COOLDOWN_MS in audioActivityDetector.ts.
const SUSTAINED_MS = 2 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
// Mirrors LISTENER_RESPAWN_BASE_MS in audioActivityDetector.ts.
const RESPAWN_MS = 5 * 1000;

test("darwin: a mic edge swallowed by the recording gate is re-evaluated when recording stops", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.setUserRecording(true);
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  assert.equal(detector._sustainedTimer, null, "a gated edge must not arm the sustained timer");

  detector.setUserRecording(false);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(emitted.length, 1, "the ongoing call must be detected once the gate lifts");
  detector.stop();
});

test("darwin: a mic edge swallowed by the dismissal cooldown is re-evaluated when it expires", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.dismiss();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  assert.equal(detector._sustainedTimer, null, "the cooldown must still swallow the prompt");

  // Split ticks: mocked timers do not cascade timers armed inside a callback.
  t.mock.timers.tick(COOLDOWN_MS);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(emitted.length, 1, "a call outlasting the cooldown must still be detected");
  detector.stop();
});

test("darwin: a dismissed call that keeps running re-prompts after the cooldown", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  t.mock.timers.tick(SUSTAINED_MS);
  assert.equal(emitted.length, 1);

  detector.dismiss();
  t.mock.timers.tick(COOLDOWN_MS);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(emitted.length, 2, "polling parity: an ongoing call re-prompts after the cooldown");
  detector.stop();
});

test("darwin: a mic that went quiet while recording does not re-prompt when recording stops", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.setUserRecording(true);
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  children[0].stdout.emit("data", "MIC_STOP 900\n");
  detector.setUserRecording(false);
  t.mock.timers.tick(SUSTAINED_MS * 2);

  assert.equal(emitted.length, 0, "a released mic must not produce a stale prompt");
  detector.stop();
});

test("darwin: a call that outlives the mic warm-hold is detected when the hold releases", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.setMicWarmHold(true);
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  assert.equal(
    detector._sustainedTimer,
    null,
    "warm-hold evidence must not arm the sustained timer"
  );

  detector.setMicWarmHold(false);
  t.mock.timers.tick(SUSTAINED_MS);

  assert.equal(emitted.length, 1, "a call still holding the mic after our hold ends must prompt");
  detector.stop();
});

test("darwin: a warm-hold that releases cleanly does not produce a stale prompt", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const { detector, children } = createDetector("darwin");
  const emitted = [];
  detector.on("sustained-audio-detected", (data) => emitted.push(data));

  await detector.start();
  detector.setMicWarmHold(true);
  children[0].stdout.emit("data", "CAPABILITY PID\nMIC_START 900\n");
  detector.setMicWarmHold(false);
  children[0].stdout.emit("data", "MIC_STOP 900\n");
  t.mock.timers.tick(SUSTAINED_MS * 2);

  assert.equal(emitted.length, 0, "the release edge must cancel the pending re-evaluation");
  detector.stop();
});
