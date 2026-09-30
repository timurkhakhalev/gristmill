const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

interface FakeTrackOptions { deviceId?: string; groupId?: string; muted?: boolean }
class FakeTrack extends EventTarget {
  readyState: string;
  muted: boolean;
  settings: { deviceId: string; groupId: string };
  stopped: boolean;
  constructor({ deviceId = "mic-1", groupId = "group-1", muted = false }: FakeTrackOptions = {}) {
    super();
    this.readyState = "live";
    this.muted = muted;
    this.settings = { deviceId, groupId };
    this.stopped = false;
  }

  getSettings() {
    return this.settings;
  }

  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
}

class FakeStream {
  track: FakeTrack | null;
  constructor(track: FakeTrack | null) {
    this.track = track;
  }

  getAudioTracks() {
    return this.track ? [this.track] : [];
  }

  getTracks() {
    return this.getAudioTracks();
  }
}

class FakeMediaDevices extends EventTarget {
  devices: Array<Record<string, string>>;
  constructor(devices: Array<Record<string, string>>) {
    super();
    this.devices = devices;
  }

  async enumerateDevices() {
    return this.devices;
  }

  change(devices: Array<Record<string, string>>) {
    this.devices = devices;
    this.dispatchEvent(new Event("devicechange"));
  }
}

type PendingResolve = (v: import("../../src/helpers/activeMicRecovery.js").RecoverableAudioStream) => void;
const mic = (deviceId: string, groupId: string = deviceId, label: string = deviceId) => ({
  kind: "audioinput",
  deviceId,
  groupId,
  label,
});

const speaker = (deviceId: string) => ({
  kind: "audiooutput",
  deviceId,
  groupId: deviceId,
  label: deviceId,
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("explicit selection waits for an in-flight recovery and then acquires the new selection", async (t) => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.ts");
  const mediaDevices = new FakeMediaDevices([mic("mic-1"), mic("mic-2"), mic("mic-3")]);
  let resolveFirst!: (stream: FakeStream) => void;
  const replacements: FakeStream[] = [];
  const reasons: string[] = [];
  const controller = new ActiveMicRecoveryController<FakeStream>({
    mediaDevices,
    acquire: async (reason) => {
      reasons.push(reason);
      if (reasons.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return new FakeStream(new FakeTrack({ deviceId: "mic-3" }));
    },
    onRecovered: async (stream) => { replacements.push(stream); },
  });
  t.after(() => controller.stop());
  await controller.start(new FakeStream(new FakeTrack()));
  const recovery = controller.recover("ended");
  const selection = controller.changeSelection(false);
  resolveFirst(new FakeStream(new FakeTrack({ deviceId: "mic-2" })));
  await recovery;
  assert.equal(await selection, true);
  assert.deepEqual(reasons, ["ended", "selection-change"]);
  assert.equal(replacements.at(-1)?.track?.settings.deviceId, "mic-3");
});

test("stop cancels a selection waiting for an older recovery", async (t) => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.ts");
  let resolveFirst!: (stream: FakeStream) => void;
  let acquired = 0;
  const controller = new ActiveMicRecoveryController<FakeStream>({
    mediaDevices: new FakeMediaDevices([mic("mic-1")]),
    acquire: () => { acquired += 1; return new Promise((resolve) => { resolveFirst = resolve; }); },
    onRecovered: async () => {},
  });
  t.after(() => controller.stop());
  await controller.start(new FakeStream(new FakeTrack()));
  const recovery = controller.recover("ended");
  const selection = controller.changeSelection(false);
  controller.stop();
  const late = new FakeStream(new FakeTrack());
  resolveFirst(late);
  await recovery;
  assert.equal(await selection, false);
  assert.equal(acquired, 1);
  assert.equal(late.track?.stopped, true);
});

test("filters output-only changes and keeps a healthy pinned microphone", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.ts");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const original = new FakeStream(new FakeTrack());
  let acquired = 0;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      acquired += 1;
      return new FakeStream(new FakeTrack({ deviceId: "mic-2" }));
    },
    onRecovered: async () => {},
    debounceMs: 1,
  });
  await controller.start(original, { followDefault: false });
  mediaDevices.change([mic("mic-1"), speaker("speaker-2")]);
  await delay(10);
  assert.equal(acquired, 0);
  controller.stop();
});

test("recovers when the system default input changes", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.ts");
  const mediaDevices = new FakeMediaDevices([mic("default", "group-1", "Mic One")]);
  const original = new FakeStream(new FakeTrack());
  const replacement = new FakeStream(new FakeTrack({ deviceId: "mic-2", groupId: "group-2" }));
  let recovered = null;
  const statuses: unknown[] = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => replacement,
    onRecovered: async (stream) => {
      recovered = stream;
    },
    onStatusChange: (status) => statuses.push(status),
    debounceMs: 1,
  });
  await controller.start(original, { followDefault: true });
  mediaDevices.change([mic("default", "group-2", "Mic Two")]);
  await delay(10);
  assert.equal(recovered, replacement);
  assert.deepEqual(statuses.slice(-2), ["reconnecting", "active"]);
  controller.stop();
});

test("track ended triggers recovery without waiting for devicechange", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.ts");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track = new FakeTrack();
  let acquired = 0;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      acquired += 1;
      return new FakeStream(new FakeTrack({ deviceId: "mic-2" }));
    },
    onRecovered: async () => {},
  });
  await controller.start(new FakeStream(track));
  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));
  await delay(1);
  assert.equal(acquired, 1);
  controller.stop();
});

test("an unavailable microphone retries and later recovers", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.ts");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track = new FakeTrack();
  let attempts = 0;
  const statuses: unknown[] = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("no mic");
      return new FakeStream(new FakeTrack({ deviceId: "mic-2" }));
    },
    onRecovered: async () => {},
    onStatusChange: (status) => statuses.push(status),
    retryMs: 5,
  });
  await controller.start(new FakeStream(track));
  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));
  await delay(20);
  assert.equal(attempts, 2);
  assert.ok(statuses.includes("unavailable"));
  assert.equal(statuses.at(-1), "active");
  controller.stop();
});

test("start() with an already-ended track recovers instead of reporting active", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.ts");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track = new FakeTrack();
  track.readyState = "ended";
  let acquired = 0;
  const statuses: unknown[] = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      acquired += 1;
      return new FakeStream(new FakeTrack({ deviceId: "mic-2" }));
    },
    onRecovered: async () => {},
    onStatusChange: (status) => statuses.push(status),
  });
  await controller.start(new FakeStream(track));
  await delay(5);
  assert.equal(acquired, 1);
  assert.equal(statuses.at(-1), "active");
  controller.stop();
});

test("a stale recovery settling late cannot clobber a newer in-flight recovery", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.ts");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track1 = new FakeTrack();
  const track2 = new FakeTrack({ deviceId: "mic-2" });
  const pendingAcquires: Array<PendingResolve> = [];
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: () => new Promise((resolve) => pendingAcquires.push(resolve)),
    onRecovered: async () => {},
  } as ConstructorParameters<typeof ActiveMicRecoveryController>[0]);
  await controller.start(new FakeStream(track1));
  track1.readyState = "ended";
  track1.dispatchEvent(new Event("ended"));
  assert.equal(pendingAcquires.length, 1);

  controller.stop();
  await controller.start(new FakeStream(track2));
  track2.readyState = "ended";
  track2.dispatchEvent(new Event("ended"));
  assert.equal(pendingAcquires.length, 2);

  pendingAcquires[0]!(new FakeStream(new FakeTrack({ deviceId: "stale" })) as never);
  await delay(1);
  // The newer recovery is still in flight; another trigger must dedupe onto it.
  track2.dispatchEvent(new Event("ended"));
  await delay(1);
  assert.equal(pendingAcquires.length, 2);

  pendingAcquires[1]!(new FakeStream(new FakeTrack({ deviceId: "mic-3" })) as never);
  await delay(1);
  controller.stop();
});

test("stop invalidates an in-flight acquisition and stops its late stream", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.ts");
  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track = new FakeTrack();
  const replacementTrack = new FakeTrack({ deviceId: "mic-2" });
  let resolveAcquire!: PendingResolve;
  let recovered = false;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: () => new Promise((resolve) => (resolveAcquire = resolve)),
    onRecovered: async () => {
      recovered = true;
    },
  } as ConstructorParameters<typeof ActiveMicRecoveryController>[0]);
  await controller.start(new FakeStream(track));
  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));
  controller.stop();
  resolveAcquire(new FakeStream(replacementTrack) as never);
  await delay(1);
  assert.equal(recovered, false);
  assert.equal(replacementTrack.stopped, true);
});
