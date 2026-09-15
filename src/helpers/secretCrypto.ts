import crypto from "crypto";
import fs from "fs";
import path from "path";
import { app, safeStorage } from "electron";
import debugLogger from "./debugLogger.js";

const SERVICE = "OpenHercules";
const ACCOUNT = "secrets-master-key";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const BACKUP_FILE = "master-key-backup.enc";

// keychain: OS keychain owns a 32-byte master key; AES-256-GCM per secret.
// safeStorage: every blob goes through Electron's OS encryption directly.
// unavailable: no backend — reads/writes of secrets fail closed.
type BackendMode = "keychain" | "safeStorage" | "unavailable";

let mode: BackendMode | null = null;
let masterKey: Buffer | null = null;

function _backupPath(): string {
  return path.join(app.getPath("userData"), "secure-keys", BACKUP_FILE);
}

// The narrow @napi-rs/keyring surface this module uses.
interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
}

function _saveMasterKeyBackup(): void {
  if (!masterKey || !safeStorage.isEncryptionAvailable()) return;
  const target = _backupPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const encrypted = safeStorage.encryptString(masterKey.toString("base64"));
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (error) {
    debugLogger.warn(
      "failed to save master key backup",
      { error: (error as Error)?.message },
      "secretCrypto"
    );
  }
}

function _loadMasterKeyBackup(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const buf = fs.readFileSync(_backupPath());
    const b64 = safeStorage.decryptString(buf);
    const key = Buffer.from(b64, "base64");
    if (key.length !== KEY_LEN) return false;
    masterKey = key;
    return true;
  } catch {
    return false;
  }
}

function _initKeychain(): boolean {
  let Entry: new (service: string, account: string) => KeyringEntry;
  try {
    ({ Entry } = require("@napi-rs/keyring"));
  } catch (error) {
    debugLogger.warn(
      "@napi-rs/keyring failed to load",
      { error: (error as Error)?.message },
      "secretCrypto"
    );
    return false;
  }

  try {
    const entry = new Entry(SERVICE, ACCOUNT);
    let stored: string | null = null;
    try {
      stored = entry.getPassword();
    } catch {
      // No entry yet (or unreadable) — generate below.
    }
    if (stored) {
      const key = Buffer.from(stored, "base64");
      if (key.length !== KEY_LEN) throw new Error("stored key length invalid");
      masterKey = key;
    } else {
      masterKey = crypto.randomBytes(KEY_LEN);
      entry.setPassword(masterKey.toString("base64"));
      // Write the safeStorage backup only when the key is first generated.
      // Re-writing on every launch invokes a second Keychain backend on macOS.
      _saveMasterKeyBackup();
    }
    return true;
  } catch (error) {
    debugLogger.warn(
      "OS keychain unavailable — falling back to safeStorage",
      { error: (error as Error)?.message, platform: process.platform },
      "secretCrypto"
    );
    return false;
  }
}

function _ensureInit(): void {
  if (mode) return;
  if (_initKeychain()) {
    mode = "keychain";
    return;
  }
  if (_loadMasterKeyBackup()) {
    mode = "keychain";
    debugLogger.info("recovered master key from safeStorage backup", {}, "secretCrypto");
    return;
  }
  mode = safeStorage.isEncryptionAvailable() ? "safeStorage" : "unavailable";
}

export function isAvailable(): boolean {
  _ensureInit();
  return mode !== "unavailable";
}

export function encrypt(plaintext: string): Buffer {
  _ensureInit();
  if (mode === "keychain" && masterKey) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, masterKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }
  if (mode === "safeStorage") return safeStorage.encryptString(plaintext);
  throw new Error("no encryption backend available");
}

export interface DecryptResult {
  value: string;
  /** Legacy safeStorage blob read while the keychain backend is active. */
  needsReencrypt: boolean;
}

export function decrypt(blob: Buffer): DecryptResult {
  _ensureInit();
  if (mode === "keychain" && masterKey && blob.length > IV_LEN + TAG_LEN) {
    try {
      const iv = blob.subarray(0, IV_LEN);
      const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const ct = blob.subarray(IV_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv(ALGO, masterKey, iv);
      decipher.setAuthTag(tag);
      const value = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
      return { value, needsReencrypt: false };
    } catch {
      // Legacy safeStorage blob — handled by the fallback below.
    }
  }
  if (safeStorage.isEncryptionAvailable()) {
    return {
      value: safeStorage.decryptString(blob),
      needsReencrypt: mode === "keychain",
    };
  }
  throw new Error("decryption failed: no backend available");
}

// Dual-export contract: named ESM exports plus the original CommonJS object
// so both `require("./secretCrypto")` and emitted cross-module imports work.
module.exports = { encrypt, decrypt, isAvailable };
