// Targeted environment/secretCrypto behavior on synthetic values and a
// temporary userData dir with fake keychain/safeStorage backends. Pins the
// storage contract: backend modes, master-key persistence, re-encrypt on
// legacy encrypted blobs, atomic writes, fail-closed saves, and no secret
// value in logs or plaintext .env files.
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");

function createFixture({
  keychainWorks = true,
  storedKey = null,
  encryptionAvailable = true,
}: { keychainWorks?: boolean; storedKey?: string | null; encryptionAvailable?: boolean } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-secret-"));
  const processPath = userData;
  (process as { resourcesPath: string }).resourcesPath = processPath;

  const logs = { warn: [] as unknown[], error: [] as unknown[], info: [] as unknown[] };
  let savedPassword: string | null = storedKey;
  const keyringEntries: Array<{ service: string; account: string }> = [];
  const safeStorageBlobs: Buffer[] = [];

  const fakeElectron = {
    app: { getPath: () => userData, getAppPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (plain: string) => {
        const blob = Buffer.from(`safe:${plain}`);
        safeStorageBlobs.push(blob);
        return blob;
      },
      decryptString: (blob: Buffer) => {
        const text = blob.toString("utf8");
        if (!text.startsWith("safe:")) throw new Error("invalid blob");
        return text.slice("safe:".length);
      },
    },
  };

  const secretCryptoModulePath = require.resolve("../../src/helpers/secretCrypto.ts");
  const environmentModulePath = require.resolve("../../src/helpers/environment.ts");
  const debugLoggerPath = require.resolve("../../src/helpers/debugLogger.ts");
  delete require.cache[secretCryptoModulePath];
  delete require.cache[environmentModulePath];

  const origLoad = Module._load;
  Module._load = function patched(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") return fakeElectron;
    if (request === "@napi-rs/keyring") {
      if (!keychainWorks) throw new Error("keyring disabled in tests");
      return {
        Entry: class Entry {
          service: string;
          account: string;
          constructor(service: string, account: string) {
            this.service = service;
            this.account = account;
            keyringEntries.push(this);
          }
          getPassword(): string | null {
            return savedPassword;
          }
          setPassword(value: string) {
            savedPassword = value;
          }
        },
      };
    }
    if ((parent as { filename?: string } | null)?.filename === secretCryptoModulePath && (request === "./debugLogger" || request === "./debugLogger.js")) {
      return {
        warn: (m: unknown, d: unknown) => logs.warn.push({ m, d }),
        error: (m: unknown, d: unknown) => logs.error.push({ m, d }),
        info: (m: unknown, d: unknown) => logs.info.push({ m, d }),
      };
    }
    if ((parent as { filename?: string } | null)?.filename === environmentModulePath && (request === "./debugLogger" || request === "./debugLogger.js")) {
      return {
        warn: (m: unknown, d: unknown) => logs.warn.push({ m, d }),
        error: (m: unknown, d: unknown) => logs.error.push({ m, d }),
        info: (m: unknown, d: unknown) => logs.info.push({ m, d }),
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  void debugLoggerPath;

  const secretCrypto: typeof import("../../src/helpers/secretCrypto.ts") = require("../../src/helpers/secretCrypto.ts");
  const EnvironmentManager = require("../../src/helpers/environment.ts");

  return {
    userData,
    logs,
    get savedPassword() {
      return savedPassword;
    },
    keyringEntries,
    safeStorageBlobs,
    secretCrypto,
    EnvironmentManager,
    restore() {
      Module._load = origLoad;
      delete require.cache[secretCryptoModulePath];
      delete require.cache[environmentModulePath];
      fs.rmSync(userData, { recursive: true, force: true });
    },
  };
}

function allLogText(logs: { warn: unknown[]; error: unknown[]; info: unknown[] }) {
  return JSON.stringify([logs.warn, logs.error, logs.info]);
}

test.afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CUSTOM_CLEANUP_API_KEY;
  delete process.env.CUSTOM_REASONING_API_KEY;
  delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
  delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// Gates writes through the manager's real persistence path: `start` decides
// which calls block on a test-controlled promise before touching the disk.
function gateSaveSecretKey(manager: { _saveSecretKey: (name: string, value: unknown) => Promise<unknown> }, shouldGate: (name: string, value: unknown) => { promise: Promise<void>; resolve: () => void } | null | false) {
  const originalSave = manager._saveSecretKey.bind(manager);
  manager._saveSecretKey = async (name: string, value: unknown) => {
    const gate = shouldGate(name, value);
    if (gate) await gate.promise;
    await originalSave(name, value);
  };
}

test("keychain backend round-trips a secret and persists the master key", () => {
  const fx = createFixture();
  try {
    assert.equal(fx.secretCrypto.isAvailable(), true);
    const blob = fx.secretCrypto.encrypt("synthetic-secret-value");
    assert.ok(Buffer.isBuffer(blob));
    assert.ok(blob.length > 12 + 16, "iv + tag + ciphertext");
    const { value, needsReencrypt } = fx.secretCrypto.decrypt(blob);
    assert.equal(value, "synthetic-secret-value");
    assert.equal(needsReencrypt, false);
    // Master key persisted to the fake keychain exactly once.
    assert.equal(typeof fx.savedPassword, "string");
    assert.equal(fx.keyringEntries.length, 1);
    // safeStorage backup written next to the generated key.
    const backup = path.join(fx.userData, "secure-keys", "master-key-backup.enc");
    assert.ok(fs.existsSync(backup));
  } finally {
    fx.restore();
  }
});

test("repeated initialization reuses the stored master key without rewriting it", () => {
  let stored = Buffer.from("a".repeat(32)).toString("base64");
  const fx = createFixture({ storedKey: stored });
  try {
    const blob1 = fx.secretCrypto.encrypt("first");
    // A second module instance (fresh load) must decrypt with the same key.
    delete require.cache[require.resolve("../../src/helpers/secretCrypto.ts")];
    const again: typeof import("../../src/helpers/secretCrypto.ts") = require("../../src/helpers/secretCrypto.ts");
    const { value } = again.decrypt(blob1);
    assert.equal(value, "first");
    assert.equal(fx.savedPassword, stored, "master key not regenerated");
  } finally {
    fx.restore();
    void stored;
  }
});

test("safeStorage fallback decrypts legacy blobs and flags re-encrypt", () => {
  // No keychain, no backup file → mode becomes safeStorage.
  const fx = createFixture({ keychainWorks: false });
  try {
    const legacy = Buffer.from("safe:legacy-value");
    const { value, needsReencrypt } = fx.secretCrypto.decrypt(legacy);
    assert.equal(value, "legacy-value");
    assert.equal(needsReencrypt, false, "safeStorage mode reads without re-encrypt flag");
  } finally {
    fx.restore();
  }
});

test("keychain mode flags legacy safeStorage blobs for re-encryption", () => {
  const fx = createFixture();
  try {
    const legacy = Buffer.from("safe:legacy-under-keychain");
    const { value, needsReencrypt } = fx.secretCrypto.decrypt(legacy);
    assert.equal(value, "legacy-under-keychain");
    assert.equal(needsReencrypt, true);
  } finally {
    fx.restore();
  }
});

test("no backend available fails closed for both encrypt and decrypt", () => {
  const fx = createFixture({ keychainWorks: false, encryptionAvailable: false });
  try {
    assert.equal(fx.secretCrypto.isAvailable(), false);
    assert.throws(() => fx.secretCrypto.encrypt("x"), /no encryption backend available/);
    assert.throws(() => fx.secretCrypto.decrypt(Buffer.from("junk")), /no backend available/);
  } finally {
    fx.restore();
  }
});

test("environment discards plaintext .env secrets and saves new keys encrypted", async () => {
  const fx = createFixture();
  try {
    const envPath = path.join(fx.userData, ".env");
    fs.writeFileSync(envPath, "OPENAI_API_KEY=plaintext-discard-me\nGOOGLE_CALENDAR_CLIENT_ID=desktop-client-id\nGOOGLE_CALENDAR_CLIENT_SECRET=old-calendar-secret\nUI_LANGUAGE=ru\n");
    fs.writeFileSync(`${envPath}.tmp`, "OPENAI_API_KEY=stale-temp-secret\n");
    process.env.OPENAI_API_KEY = "shell-secret";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "shell-calendar-secret";
    process.env.UI_LANGUAGE = "ru";

    const manager = new fx.EnvironmentManager();
    await manager.init();

    // The old value is discarded, not imported into secure storage.
    const envContent = fs.readFileSync(envPath, "utf8");
    assert.ok(!envContent.includes("plaintext-discard-me"), "secret stripped from .env");
    assert.ok(envContent.includes("old-calendar-secret"), "desktop OAuth client credential retained");
    assert.equal(process.env.GOOGLE_CALENDAR_CLIENT_ID, "desktop-client-id");
    assert.equal(process.env.GOOGLE_CALENDAR_CLIENT_SECRET, "old-calendar-secret");
    assert.ok(envContent.includes('UI_LANGUAGE="ru"'), "non-secret settings preserved");
    assert.equal(fs.existsSync(`${envPath}.tmp`), false, "stale secret temp file removed");
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    await manager.saveAllKeysToEnvFile();
    assert.ok(fs.readFileSync(envPath, "utf8").includes("GOOGLE_CALENDAR_CLIENT_ID=desktop-client-id"));
    assert.ok(fs.readFileSync(envPath, "utf8").includes("GOOGLE_CALENDAR_CLIENT_SECRET=old-calendar-secret"));
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc")), false);

    assert.deepEqual(await manager.saveOpenAIKey("new-secret"), { success: true });
    const blob = fs.readFileSync(path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc"));
    assert.ok(!blob.toString("utf8").includes("new-secret"));
    assert.equal(fs.statSync(path.join(fx.userData, "secure-keys")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc")).mode & 0o777, 0o600);
    assert.equal(process.env.OPENAI_API_KEY, "new-secret");
    // No secret value reached any log call.
    assert.ok(!allLogText(fx.logs).includes("plaintext-discard-me"));
    assert.ok(!allLogText(fx.logs).includes("new-secret"));
  } finally {
    delete process.env.UI_LANGUAGE;
    fx.restore();
  }
});

test("saving a key fails when encryption is unavailable and never writes plaintext", async () => {
  const fx = createFixture({ keychainWorks: false, encryptionAvailable: false });
  try {
    const envPath = path.join(fx.userData, ".env");
    const manager = new fx.EnvironmentManager();
    assert.deepEqual(await manager.saveOpenAIKey("rejected-secret"), { success: false });
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(fs.existsSync(path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc")), false);
    await manager.saveAllKeysToEnvFile();
    assert.ok(!fs.readFileSync(envPath, "utf8").includes("rejected-secret"));
    assert.ok(!allLogText(fx.logs).includes("rejected-secret"));
  } finally {
    fx.restore();
  }
});

test("encrypted secrets load after a new manager instance", async () => {
  const fx = createFixture();
  try {
    const first = new fx.EnvironmentManager();
    assert.deepEqual(await first.saveOpenAIKey("restart-secret"), { success: true });
    delete process.env.OPENAI_API_KEY;

    const restarted = new fx.EnvironmentManager();
    await restarted.init();

    assert.equal(process.env.OPENAI_API_KEY, "restart-secret");
    new fx.EnvironmentManager();
    assert.equal(process.env.OPENAI_API_KEY, "restart-secret", "helper managers retain active secrets");
    const blob = fs.readFileSync(path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc"));
    assert.ok(!blob.toString("utf8").includes("restart-secret"));
  } finally {
    fx.restore();
  }
});

test("clearAllPersistedData removes .env and the secure-keys directory", async () => {
  const fx = createFixture();
  try {
    const manager = new fx.EnvironmentManager();
    await manager.saveOpenAIKey("to-be-erased");
    // _saveKey persists asynchronously (keychain init + mkdir + write +
    // rename); the pending-write seam makes completion observable instead of
    // guessing at a number of ticks.
    await manager._flushSecretWrites();
    const encPath = path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc");
    assert.ok(fs.existsSync(encPath));

    const result = await manager.clearAllPersistedData();
    assert.deepEqual(result, { success: true });
    assert.equal(fs.existsSync(path.join(fx.userData, "secure-keys")), false);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
  } finally {
    fx.restore();
  }
});

test("a save fired before clearAllPersistedData cannot resurrect the secret", async () => {
  const fx = createFixture();
  try {
    const manager = new fx.EnvironmentManager();
    const save = manager.saveOpenAIKey("must-not-survive");
    // Deliberately no seam await: the clear races the in-flight write.
    const result = await manager.clearAllPersistedData();
    await save;
    assert.deepEqual(result, { success: true });
    await manager._flushSecretWrites();
    assert.equal(
      fs.existsSync(path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc")),
      false,
      "a pending write must not land after the rm"
    );
    assert.equal(process.env.OPENAI_API_KEY, undefined);
  } finally {
    fx.restore();
  }
});

// Issue #71: the pending-write map used to hold one promise per key, so a
// second save replaced the first and the clear only waited out the newest —
// the older save could land after the rm and resurrect its .enc file.
test("clear waits for every queued write of a key, not just the newest", async () => {
  const fx = createFixture();
  try {
    const manager = new fx.EnvironmentManager();
    const gateA = deferred();
    const started: unknown[] = [];
    gateSaveSecretKey(manager, (name: string, value: unknown) => {
      started.push(`${name}:${value}`);
      return started.length === 1 ? gateA : null;
    });

    const saveA = manager.saveOpenAIKey("gated-value");
    const saveB = manager.saveOpenAIKey("queued-value");
    await tick();
    assert.deepEqual(
      started,
      ["OPENAI_API_KEY:gated-value"],
      "the queued write runs after the first one settles, not concurrently"
    );

    const clearPromise = manager.clearAllPersistedData();
    let cleared = false;
    void clearPromise.then(() => {
      cleared = true;
    });
    await tick();
    assert.equal(cleared, false, "clear must not complete while the first write is pending");

    gateA.resolve();
    assert.deepEqual(await clearPromise, { success: true });
    await Promise.all([saveA, saveB]);
    await manager._flushSecretWrites();
    assert.equal(
      fs.existsSync(path.join(fx.userData, "secure-keys")),
      false,
      "neither write resurrects a .enc file after the rm"
    );
    assert.equal(process.env.OPENAI_API_KEY, undefined, "no env value is restored");
  } finally {
    fx.restore();
  }
});

test("different keys write independently and clear waits for all of them", async () => {
  const fx = createFixture();
  try {
    const manager = new fx.EnvironmentManager();
    const gates = new Map();
    gateSaveSecretKey(manager, (name: string) => gates.get(name) ?? null);
    gates.set("OPENAI_API_KEY", deferred());
    gates.set("CUSTOM_CLEANUP_API_KEY", deferred());

    const saveOpenAI = manager.saveOpenAIKey("openai-value");
    const saveCleanup = manager.saveCleanupCustomKey("cleanup-value");
    await tick();

    const clearPromise = manager.clearAllPersistedData();
    let cleared = false;
    void clearPromise.then(() => {
      cleared = true;
    });
    await tick();
    assert.equal(cleared, false);

    gates.get("OPENAI_API_KEY").resolve();
    await tick();
    assert.equal(cleared, false, "clear still waits for the second key's write");

    gates.get("CUSTOM_CLEANUP_API_KEY").resolve();
    assert.deepEqual(await clearPromise, { success: true });
    await Promise.all([saveOpenAI, saveCleanup]);
    assert.equal(fs.existsSync(path.join(fx.userData, "secure-keys")), false);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.CUSTOM_CLEANUP_API_KEY, undefined);
  } finally {
    fx.restore();
  }
});

test("a queued delete runs after its save and leaves no artifact", async () => {
  const fx = createFixture();
  try {
    const manager = new fx.EnvironmentManager();
    const encPath = path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc");
    const gate = deferred();
    let gated = true;
    gateSaveSecretKey(manager, () => {
      if (!gated) return null;
      gated = false;
      return gate;
    });

    const save = manager.saveOpenAIKey("temp-value");
    const remove = manager.saveOpenAIKey("");
    await tick();
    gate.resolve();
    await Promise.all([save, remove]);
    await manager._flushSecretWrites();

    assert.equal(fs.existsSync(encPath), false, "the delete landed after the save, not before");
    assert.equal(process.env.OPENAI_API_KEY, undefined);
  } finally {
    fx.restore();
  }
});

test("a failed write reports failure without the value and the next write still lands", async () => {
  const fx = createFixture();
  try {
    const manager = new fx.EnvironmentManager();
    const encPath = path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc");
    const originalEncrypt = fx.secretCrypto.encrypt;
    fx.secretCrypto.encrypt = () => {
      throw new Error("encrypt exploded");
    };

    assert.deepEqual(await manager.saveOpenAIKey("doomed-value"), { success: false });
    assert.equal(fs.existsSync(encPath), false, "the failed write left no artifact");
    assert.ok(
      fx.logs.error.some(
        (entry: unknown) => (entry as { d?: { key?: string } }).d?.key === "OPENAI_API_KEY"
      ),
      "the failure is logged with the key only"
    );
    assert.ok(!allLogText(fx.logs).includes("doomed-value"));

    fx.secretCrypto.encrypt = originalEncrypt;
    assert.deepEqual(await manager.saveOpenAIKey("recovered-value"), { success: true });
    assert.equal(fs.existsSync(encPath), true, "the queue continued after the failure");
    assert.equal(process.env.OPENAI_API_KEY, "recovered-value");

    assert.deepEqual(await manager.clearAllPersistedData(), { success: true });
    assert.equal(fs.existsSync(encPath), false);
  } finally {
    fx.restore();
  }
});

test("a storage write error reports failure and never activates the supplied key", async () => {
  const fx = createFixture();
  try {
    const manager = new fx.EnvironmentManager();
    const originalSave = manager._saveSecretKey.bind(manager);
    manager._saveSecretKey = async () => {
      throw Object.assign(new Error("synthetic disk failure"), { code: "ENOSPC" });
    };

    assert.deepEqual(await manager.saveOpenAIKey("write-failure-secret"), { success: false });
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(
      fs.existsSync(path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc")),
      false
    );
    assert.ok(fx.logs.error.some((entry: unknown) => (entry as { d?: { code?: string } }).d?.code === "ENOSPC"));
    assert.ok(!allLogText(fx.logs).includes("synthetic disk failure"));
    assert.ok(!allLogText(fx.logs).includes("write-failure-secret"));

    manager._saveSecretKey = originalSave;
    assert.deepEqual(await manager.saveOpenAIKey("storage-recovered-secret"), { success: true });
    assert.equal(process.env.OPENAI_API_KEY, "storage-recovered-secret");
  } finally {
    fx.restore();
  }
});
