const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  parseOnnxWorkerRequest,
  parseOnnxWorkerReply,
  isOnnxWorkerMethod,
  ONNX_WORKER_METHODS,
}: typeof import("../../src/contracts/onnxWorker.ts") = require("../../src/contracts/onnxWorker.ts");

test("the method map stays finite: ping, speaker.load, speaker.extract, shutdown", () => {
  assert.deepEqual([...ONNX_WORKER_METHODS], [
    "ping",
    "speaker.load",
    "speaker.extract",
    "shutdown",
  ]);
  assert.equal(isOnnxWorkerMethod("ping"), true);
  assert.equal(isOnnxWorkerMethod("speaker.embed"), false);
  assert.equal(isOnnxWorkerMethod("rpc.call"), false);
});

test("requests parse per-method payloads", () => {
  assert.deepEqual(parseOnnxWorkerRequest({ id: 1, method: "ping" }), {
    id: 1,
    method: "ping",
  });
  assert.deepEqual(
    parseOnnxWorkerRequest({ id: 2, method: "speaker.load", payload: { modelPath: "/m.onnx" } }),
    { id: 2, method: "speaker.load", payload: { modelPath: "/m.onnx" } }
  );
  const samplesBuffer = new ArrayBuffer(16);
  assert.deepEqual(
    parseOnnxWorkerRequest({ id: 3, method: "speaker.extract", payload: { samplesBuffer } }),
    { id: 3, method: "speaker.extract", payload: { samplesBuffer } }
  );
  assert.deepEqual(parseOnnxWorkerRequest({ id: 0, method: "shutdown", payload: {} }), {
    id: 0,
    method: "shutdown",
  });
});

test("malformed or unknown requests are rejected before model invocation", () => {
  const badRequests = [
    null,
    undefined,
    "ping",
    42,
    {},
    { method: "ping" }, // no id
    { id: "1", method: "ping" }, // non-numeric id
    { id: 1.5, method: "ping" }, // non-integer id
    { id: 1 }, // no method
    { id: 1, method: "speaker.embed" }, // unknown method
    { id: 1, method: "__proto__" },
    { id: 1, method: "speaker.load" }, // missing modelPath
    { id: 1, method: "speaker.load", payload: { modelPath: 42 } },
    { id: 1, method: "speaker.load", payload: {} },
    { id: 1, method: "speaker.extract" }, // missing buffer
    { id: 1, method: "speaker.extract", payload: { samplesBuffer: "not-a-buffer" } },
    { id: 1, method: "speaker.extract", payload: { samplesBuffer: new Uint8Array(4) } },
  ];
  for (const bad of badRequests) {
    assert.equal(parseOnnxWorkerRequest(bad), null, JSON.stringify(bad));
  }
});

test("replies parse results and typed errors, and reject anything else", () => {
  assert.deepEqual(parseOnnxWorkerReply({ id: 1, result: { ok: true } }), {
    id: 1,
    result: { ok: true },
  });
  assert.deepEqual(parseOnnxWorkerReply({ id: 2, error: { message: "boom" } }), {
    id: 2,
    error: { message: "boom" },
  });

  const badReplies = [
    null,
    {},
    { result: { ok: true } }, // no id
    { id: "1", result: { ok: true } },
    { id: 1 }, // neither result nor error
    { id: 1, error: "plain" },
    { id: 1, error: {} }, // error without message
    { id: 1, error: { message: 7 } },
  ];
  for (const bad of badReplies) {
    assert.equal(parseOnnxWorkerReply(bad), null, JSON.stringify(bad));
  }
});

// The worker module cannot be required outside a utility process (it exits
// without process.parentPort), so its dispatch path is exercised by the
// parser tests plus the packaged ping/load fixture the orchestrator runs.
// This pins the unknown-method reply text both sides still agree on.
test("an unknown-method error reply parses on the client side", () => {
  const reply = parseOnnxWorkerReply({
    id: 7,
    error: { message: "unknown method: speaker.embed" },
  });
  assert.equal(reply?.error?.message, "unknown method: speaker.embed");
});
