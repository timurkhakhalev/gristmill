// The single-upload temp lifetime of the #61 fix: the downloaded temp is
// owned by the executing run, so a Stop's reset (allowed as soon as the cancel
// RPC acknowledges the abort signal) can no longer delete the file while its
// readers are still open — deletion happens exactly once, when the execution
// settles. User-picked source files are never deleted. The test drives the
// real component callbacks (extracted from the source, since the view has no
// standalone hook boundary) against the real main-side cancel handler and
// registry.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "../..");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

let registerUploadCancelHandler;
let createUploadCancelRegistry;

test.before(async () => {
  ({ registerUploadCancelHandler } = await import("../../src/helpers/uploadCancelIpcHandler.ts"));
  ({ createUploadCancelRegistry } = await import("../../src/helpers/uploadCancelRegistry.ts"));
});

// Extracts the component-scope callbacks by name and wires them into one
// sandbox that stands in for the component closure. setDownloadedTempPath
// updates the same binding reset() reads, like the React state would.
function buildSandbox({ deletes }) {
  const source = fs.readFileSync(
    path.join(root, "src/components/notes/UploadAudioView.tsx"),
    "utf8"
  );
  const ts = require(path.join(root, "node_modules/typescript"));
  const tree = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const initializers = {};
  const wanted = new Set([
    "reset",
    "cancelTranscription",
    "handleTranscribe",
    "releaseExecutionTemp",
    "keepExecutionTempForRetry",
  ]);
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      wanted.has(node.name.getText(tree)) &&
      node.initializer
    ) {
      initializers[node.name.getText(tree)] = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const name of wanted) {
    assert.ok(initializers[name], `${name} found in UploadAudioView`);
  }

  const sandbox = {
    // refs
    runIdRef: { current: 0 },
    singleRequestIdRef: { current: null },
    executionTempRef: { current: null },
    downloadedTempPathRef: { current: null },
    progressRef: { current: null },
    progressCleanupRef: { current: null },
    // state
    downloadedTempPath: null,
    file: null,
    folders: [],
    selectedFolderId: "",
    batch: { isProcessing: false },
    // setters (only the temp state needs to round-trip)
    setDownloadedTempPath: (value) => {
      sandbox.downloadedTempPath = value;
    },
    setState: () => {},
    setFile: () => {},
    setResult: () => {},
    setPartialWarning: () => {},
    setDiarizationWarning: () => {},
    setNoteId: () => {},
    setError: () => {},
    setProgress: () => {},
    setUrlInput: () => {},
    setDownloadProgress: () => {},
    setBatchUrlNotice: () => {},
    setSelectedFolderId: () => {},
    // view dependencies
    window: { electronAPI: { deleteTempFile: (p) => deletes.push(p) } },
    crypto: require("node:crypto"),
    setInterval: () => 0,
    clearInterval: () => {},
    findDefaultFolder: () => null,
    transcriptionErrorKey: () => null,
    t: (key) => key,
    generateTitle: async () => "Generated title",
    uploadTitleFallback: () => "Uploaded note",
    saveUploadNote: async () => ({ success: true, note: { id: 1 } }),
    // transcription seam, replaced per test
    transcribeFileWithSpeakers: async () => {
      throw new Error("transcription seam not installed");
    },
    buildDiarizationSettings: async () => ({
      enabled: false,
      localModelsReady: false,
      numSpeakers: null,
    }),
    buildTranscriptionConfig: () => ({}),
  };
  for (const name of wanted) {
    // The initializers are TS source (type annotations inside the bodies);
    // transpile the parenthesized expression so vm parses plain JS.
    const expression = ts.transpileModule(`(${initializers[name]})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    sandbox[name] = vm.runInNewContext(expression, sandbox);
  }
  return sandbox;
}

// Real main-side cancel: the handler aborts the registry registration, whose
// release is gated behind a deferred "reader close" the test controls.
async function installCancelHandler({ sandbox, childClose }) {
  let closed = false;
  const handlers = new Map();
  const registry = createUploadCancelRegistry();
  registerUploadCancelHandler({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    uploadCancelRegistry: registry,
  });
  const cancel = async (_event, payload) =>
    handlers.get("cancel-upload-transcription")(_event, payload);
  sandbox.transcribeFileWithSpeakers = async () => {
    const registration = registry.register(sandbox.singleRequestIdRef.current);
    registration.signal.addEventListener("abort", () => {
      void childClose.promise.then(() => {
        closed = true;
        registration.release();
      });
    });
    return sandbox.transcription;
  };
  return {
    isClosed: () => closed,
    cancel,
  };
}

const fromUrlFile = (tempPath) => ({
  name: "video.mp4",
  path: tempPath,
  size: "1 KB",
  sizeBytes: 1024,
  fromUrl: true,
  durationSeconds: 5,
});

test("a Stop's reset never deletes the temp; the settling execution deletes it after close", async () => {
  const deletes = [];
  const sandbox = buildSandbox({ deletes });
  const childClose = deferred();
  const { isClosed, cancel } = await installCancelHandler({ sandbox, childClose });
  sandbox.window.electronAPI.cancelUploadTranscription = (payload) => cancel(null, payload);

  sandbox.downloadedTempPath = "/tmp/dl-1.wav";
  sandbox.downloadedTempPathRef.current = "/tmp/dl-1.wav";
  sandbox.file = fromUrlFile("/tmp/dl-1.wav");

  const transcriptionA = deferred();
  sandbox.transcription = transcriptionA.promise;
  const runA = sandbox.handleTranscribe();
  await tick();
  assert.equal(sandbox.executionTempRef.current, "/tmp/dl-1.wav", "the execution owns the temp");
  assert.equal(sandbox.downloadedTempPath, null, "the view no longer holds it");

  // Stop: the cancel RPC only confirms the abort signal was sent.
  await sandbox.cancelTranscription();
  assert.equal(isClosed(), false, "the reader is still open after the cancel acknowledgement");
  assert.deepEqual(deletes, [], "reset must not delete a temp with open readers");

  // A repeated Stop deletes nothing either.
  await sandbox.cancelTranscription();
  assert.deepEqual(deletes, []);

  // Start a new upload while A's readers are still open. B claims a different
  // execution temp and must remain the owner while A settles.
  sandbox.downloadedTempPath = "/tmp/dl-2.wav";
  sandbox.downloadedTempPathRef.current = "/tmp/dl-2.wav";
  sandbox.file = fromUrlFile("/tmp/dl-2.wav");
  const transcriptionB = deferred();
  sandbox.transcription = transcriptionB.promise;
  const runB = sandbox.handleTranscribe();
  await tick();
  assert.equal(sandbox.executionTempRef.current, "/tmp/dl-2.wav");

  // The reader settles (close), then the aborted A execution settles.
  childClose.resolve();
  await tick();
  assert.equal(isClosed(), true);
  transcriptionA.resolve({ success: false, code: "UPLOAD_CANCELLED" });
  await runA;
  await tick();
  await tick();
  assert.deepEqual(
    deletes,
    ["/tmp/dl-1.wav"],
    "A deletes only its own temp after close, while B's upload remains untouched"
  );
  assert.equal(sandbox.executionTempRef.current, "/tmp/dl-2.wav");

  // Finish B after the regression assertion so the fixture leaves no pending
  // execution behind for the next test.
  await sandbox.cancelTranscription();
  transcriptionB.resolve({ success: false, code: "UPLOAD_CANCELLED" });
  await runB;
  await tick();
});

test("a settled error keeps the temp for Retry and hands it back to the view", async () => {
  const deletes = [];
  const sandbox = buildSandbox({ deletes });
  sandbox.downloadedTempPath = "/tmp/dl-3.wav";
  sandbox.downloadedTempPathRef.current = "/tmp/dl-3.wav";
  sandbox.file = fromUrlFile("/tmp/dl-3.wav");

  sandbox.transcribeFileWithSpeakers = async () => ({ success: false, code: "PROVIDER_ERROR" });
  await sandbox.handleTranscribe();
  await tick();
  assert.deepEqual(deletes, [], "a failed run with Retry keeps the temp");
  assert.equal(sandbox.downloadedTempPath, "/tmp/dl-3.wav", "the view owns it again");
  assert.equal(sandbox.executionTempRef.current, null);

  // The ErrorView's reset path cleans it up, as before the fix.
  sandbox.reset();
  assert.deepEqual(deletes, ["/tmp/dl-3.wav"]);
});

test("a user-picked source file is never deleted, including by a Stop", async () => {
  const deletes = [];
  const sandbox = buildSandbox({ deletes });
  sandbox.file = { name: "rec.wav", path: "/Users/me/rec.wav", size: "2 KB", sizeBytes: 2048 };

  const transcription = deferred();
  sandbox.transcription = transcription.promise;
  sandbox.transcribeFileWithSpeakers = async () => sandbox.transcription;
  const run = sandbox.handleTranscribe();
  await tick();
  await sandbox.cancelTranscription();
  transcription.resolve({ success: false, code: "UPLOAD_CANCELLED" });
  await run;
  await tick();
  assert.deepEqual(deletes, [], "user-picked files are out of the temp lifetime");
});
