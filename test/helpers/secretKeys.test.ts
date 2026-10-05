const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const os = require("os");

const path = require("path");

const fs = require("fs");

const Module = require("module");

// Mock electron and the OS keyring before environment.js / secretCrypto load
// so tests prove that unavailable secure storage fails closed.
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-secret-test-"));

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");

Object.defineProperty(process, "resourcesPath", { configurable: true, value: tmpUserData }); // Electron-only global; harmless dummy for the .env fallback scan

const fakeElectron = {
  app: { getPath: () => tmpUserData, getAppPath: () => tmpUserData },
  safeStorage: { isEncryptionAvailable: () => false },
};

const origLoad = Module._load;

Module._load = function (request: string, ...rest: unknown[]) {
  if (request === "electron") return fakeElectron;

  if (request === "@napi-rs/keyring") throw new Error("keyring disabled in tests");

  return origLoad.call(this, request, ...rest);
};

const { BYOK_API_KEYS, SECRET_ENV_KEYS } =
  require("../../src/config/secretKeys") as typeof import("../../src/config/secretKeys");

const originalSecrets = new Map(SECRET_ENV_KEYS.map((key: string) => [key, process.env[key]]));

const EnvironmentManager = require("../../src/helpers/environment");

test.after(() => {
  Module._load = origLoad;

  if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  else Reflect.deleteProperty(process, "resourcesPath");

  for (const [key, value] of originalSecrets) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

test("manifest entries are unique and complete", () => {
  const seen = { base: new Set<string>(), env: new Set<string>(), storeKey: new Set<string>() };

  for (const k of BYOK_API_KEYS) {
    for (const field of ["base", "env", "get", "save", "storeKey"] as const) {
      assert.ok(k[field], `${field} present on ${k.base}`);
    }

    for (const field of ["base", "env", "storeKey"] as const) {
      assert.ok(!seen[field].has(k[field]), `duplicate ${field}: ${k[field]}`);
      seen[field].add(k[field]);
    }
  }

  for (const key of BYOK_API_KEYS) {
    assert.ok(SECRET_ENV_KEYS.includes(key.env), `${key.env} is marked secret`);
  }
});

test("every BYOK key accessor fails closed when secure storage is unavailable", async () => {
  const env = new EnvironmentManager();

  for (const k of BYOK_API_KEYS) {
    assert.equal(typeof env[k.get], "function", `${k.get} generated`);
    assert.equal(typeof env[k.save], "function", `${k.save} generated`);

    const secret = `sk-test-${k.base}-123`;
    delete process.env[k.env];
    assert.deepEqual(await env[k.save](secret), { success: false });
    assert.equal(env[k.get](), "", `${k.base} is not usable without secure storage`);
    assert.equal(process.env[k.env], undefined, `${k.base} is not left in process.env`);

    assert.deepEqual(await env[k.save](""), { success: true });
    assert.equal(env[k.get](), "", `${k.base} clears`);
    assert.equal(process.env[k.env], undefined, `${k.base} env var removed on clear`);
  }
});

test("openrouter is a first-class secret", async () => {
  const or = BYOK_API_KEYS.find((k) => k.base === "openrouter");
  assert.ok(or, "openrouter present in manifest");
  assert.equal(or.env, "OPENROUTER_API_KEY");
  const env = new EnvironmentManager();
  delete process.env.OPENROUTER_API_KEY;
  assert.deepEqual(await env.saveOpenrouterKey("sk-or-abc"), { success: false });
  assert.equal(env.getOpenrouterKey(), "");
});

// The accessor names come verbatim from the manifest rather than from `base`,
// and provider IPC callers use these exact spellings —
// a base-derived rename would give getAssemblyaiKey and break them silently.
test("the STT accessors keep the spellings their callers use", () => {
  const env = new EnvironmentManager();
  assert.equal(typeof env.getAssemblyAIKey, "function");
  assert.equal(typeof env.saveAssemblyAIKey, "function");
  assert.equal(typeof env.getDeepgramKey, "function");
  assert.equal(typeof env.saveDeepgramKey, "function");
  assert.equal(typeof env.getElevenLabsKey, "function");
  assert.equal(typeof env.saveElevenLabsKey, "function");
});

test("the desktop settings bridge derives its BYOK methods from the manifest", () => {
  // The bridge builds get-<base>-key / save-<base>-key methods from
  // BYOK_API_KEYS itself, so the old preload.js mirror tuples are gone and a
  // new provider is one manifest entry on both sides of the bridge.
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, "../../src/preload/desktopSettingsBridge.ts"),
    "utf8"
  );

  assert.match(bridgeSrc, /import \{ BYOK_API_KEYS \} from "\.\.\/config\/secretKeys/);
  assert.match(bridgeSrc, /get-\$\{k\.base\}-key/);
  assert.match(bridgeSrc, /save-\$\{k\.base\}-key/);
  const preloadSrc = fs.readFileSync(path.join(__dirname, "../../preload.ts"), "utf8");
  assert.doesNotMatch(preloadSrc, /BYOK_KEY_BRIDGES/, "inlined preload tuples removed");
});
