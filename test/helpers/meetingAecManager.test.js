const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/meetingAecManager.ts");
const originalLoad = Module._load;
let lastChild = null;

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    destroyed: false,
    writes: [],
    write(buffer) {
      this.writes.push(Buffer.from(buffer));
      return true;
    },
    end() {
      this.destroyed = true;
      setImmediate(() => child.emit("exit", 0, null));
    },
  };
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit("exit", 0, null));
    return true;
  };
  return child;
}

function loadManagerClass() {
  delete require.cache[managerModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
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

const MeetingAecManager = loadManagerClass();

function createManager() {
  const manager = new MeetingAecManager();
  manager.isSupported = () => true;
  manager.resolveBinary = () => "/fake/meeting-aec-helper";
  return manager;
}

test("keeps split readiness JSON and split PCM output frames intact", async () => {
  const chunks = [];
  const manager = createManager();
  const started = manager.start({ onMicChunk: (chunk) => chunks.push(chunk) });

  lastChild.stderr.emit("data", '{"type":"st');
  lastChild.stderr.emit("data", 'art"}\n');
  assert.equal(await started, true);

  const payload = Buffer.from([1, 0, 2, 0]);
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  lastChild.stdout.emit("data", frame.subarray(0, 3));
  lastChild.stdout.emit("data", frame.subarray(3));
  assert.deepEqual(chunks, [payload]);
  await manager.stop();
});

test("routes warning and error messages without settling the ready state", async () => {
  const warnings = [];
  const errors = [];
  const manager = createManager();
  const started = manager.start({
    onWarning: (warning) => warnings.push(warning),
    onError: (error) => errors.push(error),
  });
  lastChild.stderr.emit("data", '{"type":"warning","code":"device_invalidated"}\n');
  lastChild.stderr.emit("data", '{"type":"start"}\n');
  assert.equal(await started, true);
  lastChild.stderr.emit("data", '{"type":"error","message":"aec failed"}\n');
  assert.equal(warnings[0].code, "device_invalidated");
  assert.equal(errors[0].message, "aec failed");
  await manager.stop();
});

test("writes typed stream framing and reports malformed output lengths", () => {
  const errors = [];
  const manager = createManager();
  manager.process = createFakeChild();
  manager.onError = (error) => errors.push(error);

  assert.equal(manager.processSystemBuffer(Buffer.from([1, 2])), true);
  assert.equal(manager.processMicBuffer(Buffer.from([3, 4, 5, 6])), true);
  assert.equal(manager.process.stdin.writes[0].readUInt8(0), 1);
  assert.equal(manager.process.stdin.writes[0].readUInt32LE(1), 2);
  assert.equal(manager.process.stdin.writes[1].readUInt8(0), 2);
  assert.equal(manager.process.stdin.writes[1].readUInt32LE(1), 4);

  const malformed = Buffer.alloc(4);
  malformed.writeUInt32LE(3, 0);
  manager._consumeStdout(malformed);
  assert.match(errors[0].message, /invalid frame length/);
});
