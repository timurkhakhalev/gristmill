// Targeted environment/secretCrypto behavior on synthetic values and a
// temporary userData dir with fake keychain/safeStorage backends. Pins the
// storage contract from issue #41: backend modes, master-key persistence,
// re-encrypt on legacy blobs, atomic writes, migration sentinel semantics
// (failed migration preserves plaintext .env and writes no sentinel), and
// that no secret value ever reaches a log call.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function createFixture({
  keychainWorks = true,
  storedKey = null,
  encryptionAvailable = true,
} = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-secret-"));
  const processPath = userData;
  process.resourcesPath = processPath;

  const logs = { warn: [], error: [], info: [] };
  let savedPassword = storedKey;
  const keyringEntries = [];
  const safeStorageBlobs = [];

  const fakeElectron = {
    app: { getPath: () => userData, getAppPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (plain) => {
        const blob = Buffer.from(`safe:${plain}`);
        safeStorageBlobs.push(blob);
        return blob;
      },
      decryptString: (blob) => {
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
  Module._load = function patched(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (request === "@napi-rs/keyring") {
      if (!keychainWorks) throw new Error("keyring disabled in tests");
      return {
        Entry: class Entry {
          constructor(service, account) {
            this.service = service;
            this.account = account;
            keyringEntries.push(this);
          }
          getPassword() {
            return savedPassword;
          }
          setPassword(value) {
            savedPassword = value;
          }
        },
      };
    }
    if (parent?.filename === secretCryptoModulePath && (request === "./debugLogger" || request === "./debugLogger.js")) {
      return {
        warn: (m, d) => logs.warn.push({ m, d }),
        error: (m, d) => logs.error.push({ m, d }),
        info: (m, d) => logs.info.push({ m, d }),
      };
    }
    if (parent?.filename === environmentModulePath && (request === "./debugLogger" || request === "./debugLogger.js")) {
      return {
        warn: (m, d) => logs.warn.push({ m, d }),
        error: (m, d) => logs.error.push({ m, d }),
        info: (m, d) => logs.info.push({ m, d }),
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  void debugLoggerPath;

  const secretCrypto = require("../../src/helpers/secretCrypto.ts");
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

function allLogText(logs) {
  return JSON.stringify([logs.warn, logs.error, logs.info]);
}

test.afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CUSTOM_CLEANUP_API_KEY;
  delete process.env.CUSTOM_REASONING_API_KEY;
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// Gates writes through the manager's real persistence path: `start` decides
// which calls block on a test-controlled promise before touching the disk.
function gateSaveSecretKey(manager, shouldGate) {
  const originalSave = manager._saveSecretKey.bind(manager);
  manager._saveSecretKey = async (name, value) => {
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
    const again = require("../../src/helpers/secretCrypto.ts");
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

test("environment saves secrets as atomic .enc files and strips them from .env after migration", async () => {
  const fx = createFixture();
  try {
    const envPath = path.join(fx.userData, ".env");
    fs.writeFileSync(envPath, "OPENAI_API_KEY=plaintext-to-migrate\nUI_LANGUAGE=ru\n");
    process.env.OPENAI_API_KEY = "plaintext-to-migrate";
    process.env.UI_LANGUAGE = "ru";

    const manager = new fx.EnvironmentManager();
    await manager.init();

    // Sentinel written, plaintext .env regenerated without the secret.
    assert.ok(fs.existsSync(path.join(fx.userData, "secure-keys", ".migrated")));
    const envContent = fs.readFileSync(envPath, "utf8");
    assert.ok(!envContent.includes("plaintext-to-migrate"), "secret stripped from .env");
    assert.ok(envContent.includes("UI_LANGUAGE=ru"), "non-secret settings preserved");
    // Encrypted blob exists and does not contain the plaintext.
    const blob = fs.readFileSync(path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc"));
    assert.ok(!blob.toString("utf8").includes("plaintext-to-migrate"));
    assert.equal(process.env.OPENAI_API_KEY, "plaintext-to-migrate");
    // No secret value reached any log call.
    assert.ok(!allLogText(fx.logs).includes("plaintext-to-migrate"));
  } finally {
    delete process.env.UI_LANGUAGE;
    fx.restore();
  }
});

test("a failed migration preserves the plaintext .env and writes no sentinel", async () => {
  const fx = createFixture();
  // Break decryption after encryption so round-trip verification fails.
  const originalDecrypt = fx.secretCrypto.decrypt;
  fx.secretCrypto.decrypt = () => ({ value: "mismatch", needsReencrypt: false });
  try {
    const envPath = path.join(fx.userData, ".env");
    fs.writeFileSync(envPath, "OPENAI_API_KEY=precious-plaintext\n");
    process.env.OPENAI_API_KEY = "precious-plaintext";

    const manager = new fx.EnvironmentManager();
    await manager.init();

    assert.equal(fs.existsSync(path.join(fx.userData, "secure-keys", ".migrated")), false);
    const envContent = fs.readFileSync(envPath, "utf8");
    assert.ok(
      envContent.includes("precious-plaintext"),
      "plaintext .env preserved on failed migration"
    );
    assert.ok(fx.logs.error.some((entry) => /aborted/.test(entry.m)));
    assert.ok(!allLogText(fx.logs).includes("precious-plaintext"), "no secret in logs");
  } finally {
    void originalDecrypt;
    fx.restore();
  }
});

test("clearAllPersistedData removes .env and the secure-keys directory", async () => {
  const fx = createFixture();
  try {
    const manager = new fx.EnvironmentManager();
    manager.saveOpenAIKey("to-be-erased");
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
    manager.saveOpenAIKey("must-not-survive");
    // Deliberately no seam await: the clear races the in-flight write.
    const result = await manager.clearAllPersistedData();
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
    const started = [];
    gateSaveSecretKey(manager, (name, value) => {
      started.push(`${name}:${value}`);
      return started.length === 1 ? gateA : null;
    });

    manager.saveOpenAIKey("gated-value");
    manager.saveOpenAIKey("queued-value");
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
    gateSaveSecretKey(manager, (name) => gates.get(name) ?? null);
    gates.set("OPENAI_API_KEY", deferred());
    gates.set("CUSTOM_CLEANUP_API_KEY", deferred());

    manager.saveOpenAIKey("openai-value");
    manager.saveCleanupCustomKey("cleanup-value");
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

    manager.saveOpenAIKey("temp-value");
    manager.saveOpenAIKey("");
    await tick();
    gate.resolve();
    await manager._flushSecretWrites();

    assert.equal(fs.existsSync(encPath), false, "the delete landed after the save, not before");
    assert.equal(process.env.OPENAI_API_KEY, undefined);
  } finally {
    fx.restore();
  }
});

test("a failed write is logged without the value and the next write still lands", async () => {
  const fx = createFixture();
  try {
    const manager = new fx.EnvironmentManager();
    const encPath = path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc");
    const originalEncrypt = fx.secretCrypto.encrypt;
    fx.secretCrypto.encrypt = () => {
      throw new Error("encrypt exploded");
    };

    manager.saveOpenAIKey("doomed-value");
    await manager._flushSecretWrites();
    assert.equal(fs.existsSync(encPath), false, "the failed write left no artifact");
    assert.ok(
      fx.logs.error.some(
        (entry) => entry.d?.key === "OPENAI_API_KEY" && /encrypt exploded/.test(entry.d?.error)
      ),
      "the failure is logged with the key and error, never the value"
    );
    assert.ok(!allLogText(fx.logs).includes("doomed-value"));

    fx.secretCrypto.encrypt = originalEncrypt;
    manager.saveOpenAIKey("recovered-value");
    await manager._flushSecretWrites();
    assert.equal(fs.existsSync(encPath), true, "the queue continued after the failure");
    assert.equal(process.env.OPENAI_API_KEY, "recovered-value");

    assert.deepEqual(await manager.clearAllPersistedData(), { success: true });
    assert.equal(fs.existsSync(encPath), false);
  } finally {
    fx.restore();
  }
});
