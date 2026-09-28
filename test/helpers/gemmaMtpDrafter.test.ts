const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Module = require("node:module");
const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");

const modelManagerModulePath = require.resolve("../../src/helpers/modelManagerBridge.ts");
const modelDirUtilsModulePath = require.resolve("../../src/helpers/modelDirUtils.ts");
const originalLoad = Module._load;
let electronHome = os.tmpdir();

const QAT_ID = "gemma-4-e2b-it-qat-q4_0";
const NON_QAT_ID = "gemma-4-e2b-it-q4_k_m";

function loadModelManager() {
  delete require.cache[modelManagerModulePath];
  delete require.cache[modelDirUtilsModulePath];

  Module._load = function loadWithMocks(request: string) {
    if (request === "electron") {
      return {
        app: {
          isReady: () => true,
          getAppPath: () => process.cwd(),
          getPath: (name: string) => (name === "home" ? electronHome : path.join(electronHome, name)),
        },
        net: {},
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    // modelManagerBridge requires modelDirUtils lazily (inside getModelsDir),
    // after this mock is uninstalled — load it now so its electron binding is
    // the stub and modelsDir resolves inside the per-test temp home instead of
    // the real ~/.cache/openwhispr (where deleteModel would touch real files).
    require("../../src/helpers/modelDirUtils.ts");
    return require("../../src/helpers/modelManagerBridge.ts").default;
  } finally {
    Module._load = originalLoad;
  }
}

async function withHome(prefix: string, fn: (home: string) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  electronHome = home;
  try {
    return await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

const OVER_MIN = Buffer.alloc(1_000_001, 1); // > MIN_FILE_SIZE (1MB)
const UNDER_MIN = Buffer.alloc(500, 1);

test("modelHasDrafter is true only for entries declaring a drafter", () => {
  const mm = loadModelManager();
  const qat = mm.findModelById(QAT_ID).model;
  const plain = mm.findModelById(NON_QAT_ID).model;
  assert.equal(mm.modelHasDrafter(qat), true);
  assert.equal(mm.modelHasDrafter(plain), false);
  assert.equal(mm.modelHasDrafter(undefined), false);
});

test("getDraftDownloadUrl mirrors the main URL shape", () => {
  const mm = loadModelManager();
  const { model, provider } = mm.findModelById(QAT_ID);
  assert.equal(
    mm.getDraftDownloadUrl(provider, model),
    `${provider.baseUrl}/${model.draftHfRepo}/resolve/main/${model.draftFileName}`
  );
});

test("resolveDraftPath returns the path only when a valid drafter file exists", async () => {
  await withHome("openwhispr-draft-resolve-", async () => {
    const mm = loadModelManager();
    mm.ensureInitialized();
    await fs.mkdir(mm.modelsDir, { recursive: true });

    const model = mm.findModelById(QAT_ID).model;
    const draftPath = path.join(mm.modelsDir, model.draftFileName);

    // Missing drafter → null (keeps today's behavior for pre-feature downloads).
    assert.equal(await mm.resolveDraftPath(model), null);

    // Too small → fails the >1MB gate → null.
    await fs.writeFile(draftPath, UNDER_MIN);
    assert.equal(await mm.resolveDraftPath(model), null);

    // Valid drafter → returns the path.
    await fs.writeFile(draftPath, OVER_MIN);
    assert.equal(await mm.resolveDraftPath(model), draftPath);

    // A model with no drafter declared → always null.
    assert.equal(await mm.resolveDraftPath(mm.findModelById(NON_QAT_ID).model), null);
  });
});

test("deleteModel removes the drafter alongside the main file, ignoring a missing drafter", async () => {
  await withHome("openwhispr-draft-delete-", async () => {
    const mm = loadModelManager();
    mm.ensureInitialized();
    await fs.mkdir(mm.modelsDir, { recursive: true });

    const model = mm.findModelById(QAT_ID).model;
    const mainPath = path.join(mm.modelsDir, model.fileName);
    const draftPath = path.join(mm.modelsDir, model.draftFileName);

    await fs.writeFile(mainPath, OVER_MIN);
    await fs.writeFile(draftPath, OVER_MIN);

    await mm.deleteModel(QAT_ID);
    assert.equal(await mm.checkFileExists(mainPath), false);
    assert.equal(await mm.checkFileExists(draftPath), false);

    // Main present, drafter already gone → no throw.
    await fs.writeFile(mainPath, OVER_MIN);
    await mm.deleteModel(QAT_ID);
    assert.equal(await mm.checkFileExists(mainPath), false);
  });
});

// Context size is the third restart trigger; it is covered in
// test/helpers/llamaServerContext.test.js. Every start() here passes the same
// (default) context, so this file isolates the model/drafter dimension.
test("llama-server start restarts only when model or drafter presence changes", async () => {
  const LlamaServerManager: typeof import("../../src/helpers/llamaServer.ts").LlamaServerManager = require("../../src/helpers/llamaServer.ts");
  const manager = new LlamaServerManager();

  const calls: unknown[] = [];
  manager._doStart = async (modelPath: string, options: { draftModelPath?: string | null }) => {
    manager.ready = true;
    manager.modelPath = modelPath;
    manager.draftModelPath = options.draftModelPath || null;
    calls.push({ modelPath, draftModelPath: manager.draftModelPath });
  };

  await manager.start("/models/main.gguf", {});
  assert.equal(calls.length, 1);

  // Same model, no drafter → no restart.
  await manager.start("/models/main.gguf", {});
  assert.equal(calls.length, 1);

  // Drafter appears for the same model → restart.
  await manager.start("/models/main.gguf", { draftModelPath: "/models/draft.gguf" });
  assert.equal(calls.length, 2);
  assert.equal(manager.draftModelPath, "/models/draft.gguf");

  // Same model, same drafter → no restart.
  await manager.start("/models/main.gguf", { draftModelPath: "/models/draft.gguf" });
  assert.equal(calls.length, 2);

  // Drafter disappears → restart.
  await manager.start("/models/main.gguf", {});
  assert.equal(calls.length, 3);
  assert.equal(manager.draftModelPath, null);
});

test("degraded start does not churn on identical requests", async () => {
  const LlamaServerManager: typeof import("../../src/helpers/llamaServer.ts").LlamaServerManager = require("../../src/helpers/llamaServer.ts");
  const manager = new LlamaServerManager();

  let starts = 0;
  manager._doStart = async (modelPath: string, options: { draftModelPath?: string | null }) => {
    starts++;
    manager.ready = true;
    manager.modelPath = modelPath;
    manager.draftModelPath = options.draftModelPath || null; // REQUESTED, stays stable
    manager.activeDraftModelPath = null; // simulate a degraded start (drafter dropped)
  };

  await manager.start("/models/main.gguf", { draftModelPath: "/models/draft.gguf" });
  assert.equal(starts, 1);
  assert.equal(manager.draftModelPath, "/models/draft.gguf");
  assert.equal(manager.activeDraftModelPath, null);

  // Identical request must NOT bounce the ready server despite the degrade.
  await manager.start("/models/main.gguf", { draftModelPath: "/models/draft.gguf" });
  assert.equal(starts, 1);
});

test("stop() clears both the requested and active draft paths", async () => {
  const LlamaServerManager = require("../../src/helpers/llamaServer.ts");
  const manager = new LlamaServerManager();

  manager.draftModelPath = "/models/draft.gguf";
  manager.activeDraftModelPath = "/models/draft.gguf";
  manager.ready = true;
  manager.process = {
    exitCode: undefined,
    kill() {},
    once(event: unknown, cb: () => void) {
      if (event === "close") cb();
    },
  };

  await manager.stop();
  assert.equal(manager.draftModelPath, null);
  assert.equal(manager.activeDraftModelPath, null);
});
