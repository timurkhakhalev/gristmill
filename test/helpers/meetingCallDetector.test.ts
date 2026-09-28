const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
  if (request === "./binaryResolver.js") return { resolveBundledBinary: () => null };
  if (request === "./debugLogger.js") return { debug() {}, info() {}, warn() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { MeetingCallDetector }: typeof import("../../src/helpers/meetingCallDetector.ts") = require("../../src/helpers/meetingCallDetector.ts");
Module._load = originalLoad;

test("Zoom needs two complete inactive snapshots before a new call can prompt", async () => {
  let snapshot = "present\tzoom:123\nactive\tzoom:123";
  const detector = new MeetingCallDetector(async () => snapshot);
  const active = [];
  const ended: unknown[] = [];
  detector.on("call-active", (call: unknown) => active.push(call));
  detector.on("call-ended", (call: unknown) => ended.push(call));
  await detector.poll();
  snapshot = "present\tzoom:123\ninactive\tzoom:123";
  await detector.poll();
  assert.equal(ended.length, 0);
  snapshot = "unknown\tzoom";
  await detector.poll();
  assert.equal(ended.length, 0);
  snapshot = "present\tzoom:123\ninactive\tzoom:123";
  await detector.poll();
  assert.deepEqual(ended, [{ key: "zoom:123" }]);
  snapshot = "present\tzoom:123\nactive\tzoom:123";
  await detector.poll();
  assert.equal(active.length, 2);
});

test("a hidden Meet tab does not end a call; the same page without Leave does", async () => {
  const key = `meet:${"a".repeat(64)}`;
  let snapshot = `active\t${key}`;
  const detector = new MeetingCallDetector(async () => snapshot);
  const ended: unknown[] = [];
  detector.on("call-ended", (call: unknown) => ended.push(call));
  await detector.poll();
  snapshot = "";
  await detector.poll();
  assert.equal(ended.length, 0);
  snapshot = `inactive\t${key}`;
  await detector.poll();
  await detector.poll();
  assert.deepEqual(ended, [{ key }]);
});

test("unknown AX state and malformed keys never report an active call", async () => {
  const detector = new MeetingCallDetector(async () => "unknown\taccessibility\nactive\tmeet:bad");
  let prompts = 0;
  detector.on("call-active", () => prompts++);
  await detector.poll();
  assert.equal(prompts, 0);
});
