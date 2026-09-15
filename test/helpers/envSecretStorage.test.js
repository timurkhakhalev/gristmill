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
    // _saveKey persists asynchronously (keychain init + mkdir + write + rename);
    // wait until the blob lands instead of assuming a fixed number of ticks.
    const encPath = path.join(fx.userData, "secure-keys", "OPENAI_API_KEY.enc");
    for (let i = 0; i < 50 && !fs.existsSync(encPath); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(fs.existsSync(encPath));

    const result = await manager.clearAllPersistedData();
    assert.deepEqual(result, { success: true });
    assert.equal(fs.existsSync(path.join(fx.userData, "secure-keys")), false);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
  } finally {
    fx.restore();
  }
});
