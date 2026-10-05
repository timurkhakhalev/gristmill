// The single-upload temp lifetime of the #61 fix: the downloaded temp is
// owned by the executing run, so a Stop's reset (allowed as soon as the cancel
// RPC acknowledges the abort signal) can no longer delete the file while its
// readers are still open — deletion happens exactly once, when the execution
// settles. User-picked source files are never deleted. The test drives the
// real component callbacks (extracted from the source, since the view has no
// standalone hook boundary) against the real main-side cancel handler and
// registry.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const vm: typeof import("node:vm") = require("node:vm");

const root = path.join(__dirname, "../..");
const tick = () => new Promise((resolve) => setImmediate(resolve));

interface TestDeferred {
  promise: Promise<unknown>;
  resolve: (value?: unknown) => void;
}

const deferred = (): TestDeferred => {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// The view closure stand-in: the extracted initializers are installed onto it
// below, so the seams the tests drive are declared and stubbed here.
interface Sandbox {
  runIdRef: { current: number };
  singleRequestIdRef: { current: string | null };
  executionTempRef: { current: string | null };
  pendingSaveRef: { current: unknown };
  downloadedTempPathRef: { current: string | null };
  mountedRef: { current: boolean };
  downloadedTempPath: string | null;
  file: Record<string, unknown> | null;
  setDownloadedTempPath(value: string | null): void;
  t(key: string): string;
  window: {
    electronAPI: {
      deleteTempFile(path: string): void;
      cancelUploadTranscription?: (payload: unknown) => unknown;
    };
  };
  transcribeFileWithSpeakers(): Promise<unknown>;
  transcription?: Promise<unknown>;
  handleTranscribe(): Promise<unknown>;
  cancelTranscription(): Promise<unknown>;
  reset(): void;
  runMountEffect(): () => void;
  [key: string]: unknown;
  handleRetry(): Promise<void>;
}

let registerUploadCancelHandler!: typeof import("../../src/helpers/uploadCancelIpcHandler.ts")["registerUploadCancelHandler"];
let createUploadCancelRegistry!: typeof import("../../src/helpers/uploadCancelRegistry.ts")["createUploadCancelRegistry"];

test.before(async () => {
  ({ registerUploadCancelHandler } = await import("../../src/helpers/uploadCancelIpcHandler.ts"));
  ({ createUploadCancelRegistry } = await import("../../src/helpers/uploadCancelRegistry.ts"));
});

// Extracts the component-scope callbacks by name and wires them into one
// sandbox that stands in for the component closure. setDownloadedTempPath
// updates the same binding reset() reads, like the React state would.
function buildSandbox({ deletes }: { deletes: string[] }) {
  const source = fs.readFileSync(
    path.join(root, "src/components/notes/UploadAudioView.tsx"),
    "utf8"
  );
  const ts: typeof import("typescript") = require(path.join(root, "node_modules/typescript"));
  const tree = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const initializers: Record<string, string> = {};
  const wanted = new Set([
    "reset",
    "cancelTranscription",
    "handleTranscribe",
    "releaseExecutionTemp",
    "keepExecutionTempForRetry",
    "handleRetry",
  ]);
  const visit = (node: import("typescript").Node) => {
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

  const sandbox: Sandbox = {
    // refs
    runIdRef: { current: 0 },
    singleRequestIdRef: { current: null },
    executionTempRef: { current: null },
    pendingSaveRef: { current: null },
    downloadedTempPathRef: { current: null },
    progressRef: { current: null },
    progressCleanupRef: { current: null },
    urlDownloadActiveRef: { current: false },
    mountedRef: { current: true },
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
    setFolderMoveError: () => {},
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
    // stubs for the seams the extracted initializers overwrite below
    reset: () => {},
    cancelTranscription: async () => {},
    handleTranscribe: async () => {},
    handleRetry: async () => {},
    runMountEffect: () => () => {},
  };
  for (const name of wanted) {
    // The initializers are TS source (type annotations inside the bodies);
    // transpile the parenthesized expression so vm parses plain JS.
    const expression = ts.transpileModule(`(${initializers[name]})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    sandbox[name] = vm.runInNewContext(expression, sandbox);
  }

  // The mount effect owns the real unmount cleanup (mountedRef flip +
  // view-owned temp deletion); expose it so tests unmount through the real
  // component path instead of poking mountedRef directly.
  const mountEffects: string[] = [];
  const visitEffects = (node: import("typescript").Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect") {
      const arg = node.arguments[0];
      if (arg && arg.getText(tree).includes("mountedRef.current = true")) {
        mountEffects.push(arg.getText(tree));
      }
    }
    ts.forEachChild(node, visitEffects);
  };
  visitEffects(tree);
  assert.equal(mountEffects.length, 1, "the mount effect with the unmount cleanup is unique");
  sandbox.runMountEffect = vm.runInNewContext(`(${mountEffects[0]})`, sandbox);
  return sandbox;
}

// Drives the component's real mount effect and its cleanup, exactly like
// React would on unmount.
function unmountView(sandbox: Sandbox) {
  sandbox.mountedRef.current = true;
  const cleanup = sandbox.runMountEffect();
  cleanup();
}

// Real main-side cancel: the handler aborts the registry registration, whose
// release is gated behind a deferred "reader close" the test controls.
async function installCancelHandler({ sandbox, childClose }: { sandbox: Sandbox; childClose: TestDeferred }) {
  let closed = false;
  const handlers = new Map();
  const registry = createUploadCancelRegistry();
  registerUploadCancelHandler({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    uploadCancelRegistry: registry,
  });
  const cancel = async (_event: unknown, payload: unknown) =>
    handlers.get("cancel-upload-transcription")(_event, payload);
  sandbox.transcribeFileWithSpeakers = async () => {
    const registration = registry.register(sandbox.singleRequestIdRef.current);
    registration.signal!.addEventListener("abort", () => {
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

const fromUrlFile = (tempPath: string) => ({
  name: "video.mp4",
  path: tempPath,
  size: "1 KB",
  sizeBytes: 1024,
  fromUrl: true,
  durationSeconds: 5,
});

test("a Stop's reset never deletes the temp; the settling execution deletes it after close", async () => {
  const deletes: string[] = [];
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
  const deletes: string[] = [];
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
  const deletes: string[] = [];
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

// Issue #71: a failure settling after unmount used to hand the temp back to
// a view that no longer exists — its unmount cleanup had already run and
// found no view-owned temp, so nothing ever deleted the file.
test("a failure settling after unmount deletes the temp instead of leaking it", async () => {
  const deletes: string[] = [];
  const sandbox = buildSandbox({ deletes });
  sandbox.downloadedTempPath = "/tmp/dl-4.wav";
  sandbox.downloadedTempPathRef.current = "/tmp/dl-4.wav";
  sandbox.file = fromUrlFile("/tmp/dl-4.wav");

  const gate = deferred();
  sandbox.transcribeFileWithSpeakers = async () => {
    await gate.promise;
    return { success: false, code: "PROVIDER_ERROR" };
  };
  const run = sandbox.handleTranscribe();
  await tick();
  assert.equal(sandbox.executionTempRef.current, "/tmp/dl-4.wav", "the execution owns the temp");

  // Real unmount while the readers are open: the cleanup finds no
  // view-owned temp and must not delete the execution's file early.
  unmountView(sandbox);
  assert.equal(sandbox.mountedRef.current, false);
  assert.deepEqual(deletes, [], "the in-flight temp is not view-owned, cleanup deletes nothing");

  gate.resolve();
  await run;
  await tick();
  assert.deepEqual(
    deletes,
    ["/tmp/dl-4.wav"],
    "the settling failure deletes the temp exactly once, after the readers finished"
  );
  assert.equal(sandbox.executionTempRef.current, null);
  assert.equal(sandbox.downloadedTempPath, null, "no Retry hand-back to the unmounted view");
});

test("a thrown settlement after unmount deletes the temp instead of leaking it", async () => {
  const deletes: string[] = [];
  const sandbox = buildSandbox({ deletes });
  sandbox.downloadedTempPath = "/tmp/dl-5.wav";
  sandbox.downloadedTempPathRef.current = "/tmp/dl-5.wav";
  sandbox.file = fromUrlFile("/tmp/dl-5.wav");

  const gate = deferred();
  sandbox.transcribeFileWithSpeakers = async () => {
    await gate.promise;
    throw new Error("reader blew up");
  };
  const run = sandbox.handleTranscribe();
  await tick();
  unmountView(sandbox);
  assert.deepEqual(deletes, []);

  gate.resolve();
  await run;
  await tick();
  assert.deepEqual(deletes, ["/tmp/dl-5.wav"], "the thrown settlement still cleans the temp up");
  assert.equal(sandbox.downloadedTempPath, null);
});

// Issue #145: a failed Note save used to report a complete upload. The save
// failure must surface as an error state and Retry must re-save the ASR
// result without re-transcribing.
for (const failure of ["structured", "rejected"] as const) {
test(`a ${failure} first Note save retries without re-transcribing`, async () => {
  const deletes: string[] = [];
  const sandbox = buildSandbox({ deletes });
  const states: string[] = [];
  sandbox.setState = (s: string) => states.push(s);
  const savedTexts: string[] = [];
  let saveFails = true;
  sandbox.saveUploadNote = async (params: { text: string }) => {
    savedTexts.push(params.text);
    if (saveFails && failure === "rejected") throw new Error("DB unavailable");
    return saveFails ? { success: false } : { success: true, note: { id: 7 } };
  };
  sandbox.downloadedTempPath = "/tmp/dl-6.wav";
  sandbox.downloadedTempPathRef.current = "/tmp/dl-6.wav";
  sandbox.file = fromUrlFile("/tmp/dl-6.wav");

  let transcriptions = 0;
  sandbox.transcribeFileWithSpeakers = async () => {
    transcriptions++;
    return { success: true, text: "hello world", segments: [] };
  };

  await sandbox.handleTranscribe();
  assert.equal(transcriptions, 1);
  assert.ok(!states.includes("complete"), "a save failure must not report complete");
  assert.deepEqual(states.slice(-1), ["error"]);
  assert.ok(sandbox.pendingSaveRef.current, "the ASR result is kept for a re-save");
  assert.deepEqual(deletes, [], "the temp is kept for Retry");

  // Retry re-saves the kept result: no second transcription.
  saveFails = false;
  sandbox.transcribeFileWithSpeakers = async () => { transcriptions++; throw new Error("provider offline"); };
  await sandbox.handleRetry();
  assert.equal(transcriptions, 1, "Retry must not re-transcribe");
  assert.deepEqual(savedTexts, ["hello world", "hello world"]);
  assert.equal(sandbox.pendingSaveRef.current, null);
  assert.deepEqual(states.slice(-1), ["complete"]);
  assert.deepEqual(deletes, ["/tmp/dl-6.wav"], "the successful re-save releases the temp");
  assert.equal(sandbox.downloadedTempPath, null, "the view no longer holds the released temp");

  // Start Over (the temp is already gone) deletes nothing again.
  sandbox.reset();
  assert.equal(sandbox.pendingSaveRef.current, null);
  assert.deepEqual(deletes, ["/tmp/dl-6.wav"]);
});

}

// The pending re-save's own settlement paths.
test("a rejected save in the pending re-save is caught and Retry still re-saves", async () => {
  const deletes: string[] = [];
  const sandbox = buildSandbox({ deletes });
  const states: string[] = [];
  sandbox.setState = (s: string) => states.push(s);
  sandbox.downloadedTempPath = "/tmp/dl-7.wav";
  sandbox.downloadedTempPathRef.current = "/tmp/dl-7.wav";
  sandbox.file = fromUrlFile("/tmp/dl-7.wav");
  sandbox.transcribeFileWithSpeakers = async () => ({
    success: true,
    text: "hello world",
    segments: [],
  });

  let calls = 0;
  sandbox.saveUploadNote = async () => {
    calls++;
    if (calls === 1) return { success: false };
    if (calls === 2) throw new Error("db write failed");
    return { success: true, note: { id: 7 } };
  };

  await sandbox.handleTranscribe();
  assert.deepEqual(states.slice(-1), ["error"]);
  assert.ok(sandbox.pendingSaveRef.current);

  // Retry 1: the save IPC rejects — the view shows the error state and keeps
  // the pending result instead of an unhandled rejection.
  await sandbox.handleRetry();
  assert.deepEqual(states.slice(-1), ["error"], "a rejected re-save must not wedge the view");
  assert.ok(sandbox.pendingSaveRef.current, "the result survives a rejected re-save");
  assert.deepEqual(deletes, []);

  // Retry 2 succeeds.
  await sandbox.handleRetry();
  assert.deepEqual(states.slice(-1), ["complete"]);
  assert.equal(sandbox.pendingSaveRef.current, null);
  assert.deepEqual(deletes, ["/tmp/dl-7.wav"]);
});

test("Cancel during the pending re-save drops the late settlement", async () => {
  const deletes: string[] = [];
  const sandbox = buildSandbox({ deletes });
  const states: string[] = [];
  sandbox.setState = (s: string) => states.push(s);
  sandbox.downloadedTempPath = "/tmp/dl-8.wav";
  sandbox.downloadedTempPathRef.current = "/tmp/dl-8.wav";
  sandbox.file = fromUrlFile("/tmp/dl-8.wav");
  sandbox.transcribeFileWithSpeakers = async () => ({
    success: true,
    text: "hello world",
    segments: [],
  });
  sandbox.saveUploadNote = async () => ({ success: false });

  await sandbox.handleTranscribe();
  assert.deepEqual(states.slice(-1), ["error"]);

  const gate = deferred();
  sandbox.saveUploadNote = async () => {
    await gate.promise;
    return { success: true, note: { id: 9 } };
  };
  const retry = sandbox.handleRetry();
  await tick();
  assert.deepEqual(states.slice(-1), ["transcribing"]);

  // Cancel resets the view while the re-save is in flight.
  await sandbox.cancelTranscription();
  assert.deepEqual(states.slice(-1), ["idle"], "Cancel reset the view");

  gate.resolve();
  await retry;
  await tick();
  assert.ok(!states.includes("complete"), "the late re-save settlement must not publish complete");
  assert.deepEqual(
    deletes,
    ["/tmp/dl-8.wav"],
    "reset deleted the view-owned temp; the dropped settlement deletes nothing more"
  );
  assert.equal(
    sandbox.pendingSaveRef.current,
    null,
    "the Cancel reset discarded the pending result along with the view"
  );
});
