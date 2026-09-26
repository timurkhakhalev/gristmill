import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";
import { app } from "electron";
import debugLogger from "./debugLogger.js";
import { normalizeUiLanguage } from "./i18nMain.js";
import * as secretCrypto from "./secretCrypto.js";
import { BYOK_API_KEYS, SECRET_ENV_KEYS } from "../config/secretKeys.js";

// Env-var names that hold secret values: persisted only as encrypted
// `<name>.enc` blobs and never loaded from plaintext .env files.
type SecretEnvKey =
  | (typeof BYOK_API_KEYS)[number]["env"]
  | "CORTI_CLIENT_ID"
  | "CORTI_CLIENT_SECRET"
  | "CUSTOM_TRANSCRIPTION_API_KEY"
  | "CUSTOM_CLEANUP_API_KEY"
  | "BEDROCK_ACCESS_KEY_ID"
  | "BEDROCK_SECRET_ACCESS_KEY"
  | "BEDROCK_SESSION_TOKEN"
  | "AZURE_OPENAI_API_KEY"
  | "VERTEX_API_KEY"
  | "VOICE_AGENT_KEY"
  | "TRANSLATION_KEY";

const SECRET_KEYS: readonly SecretEnvKey[] = [
  ...BYOK_API_KEYS.map((k) => k.env),
  "CORTI_CLIENT_ID",
  "CORTI_CLIENT_SECRET",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_CLEANUP_API_KEY",
  "BEDROCK_ACCESS_KEY_ID",
  "BEDROCK_SECRET_ACCESS_KEY",
  "BEDROCK_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "VERTEX_API_KEY",
  "VOICE_AGENT_KEY",
  "TRANSLATION_KEY",
];

const SECRET_KEY_SET: ReadonlySet<string> = new Set(SECRET_ENV_KEYS.map((key) => key.toUpperCase()));

function isSecretEnvKey(key: string): boolean {
  return SECRET_KEY_SET.has(key.toUpperCase());
}

// Non-secret settings also persisted into .env (order matters: it is the
// write order of the regenerated file).
const PERSISTED_KEYS: readonly string[] = [
  "LOCAL_TRANSCRIPTION_PROVIDER",
  "PARAKEET_MODEL",
  "DICTATION_LANGUAGE",
  "LOCAL_WHISPER_MODEL",
  "CLEANUP_PROVIDER",
  "LOCAL_CLEANUP_MODEL",
  "DICTATION_AGENT_PROVIDER",
  "LOCAL_DICTATION_AGENT_MODEL",
  "DICTATION_KEY",
  "ACTIVATION_MODE",
  "FLOATING_ICON_AUTO_HIDE",
  "PANEL_START_POSITION",
  "START_MINIMIZED",
  "UI_LANGUAGE",
  "GOOGLE_CALENDAR_CLIENT_ID",
  // Google Desktop OAuth distributes this credential with the client; PKCE protects the code.
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "WHISPER_THREADS",
  "BEDROCK_REGION",
  "BEDROCK_PROFILE",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
  "VERTEX_PROJECT",
  "VERTEX_LOCATION",
];

// A type alias, not an interface: aliases of object literals carry an
// implicit index signature, so results stay assignable to the loose
// `{ [key: string]: unknown; success: boolean }` wire shapes.
type SaveKeyResult = {
  success: boolean;
};

// Module-level so writes are serialized across all instances — hotkeyManager
// creates its own EnvironmentManager alongside the main.js singleton.
let envWriteQueue: Promise<unknown> = Promise.resolve();
let plaintextSecretEnvironmentCleared = false;

export class EnvironmentManager {
  // Tail of each key's secret-write chain so writes to one key stay ordered
  // and clearAllPersistedData cannot race a pending write.
  _pendingSecretWrites = new Map<string, Promise<void>>();

  constructor() {
    this.loadEnvironmentVariables();
  }

  loadEnvironmentVariables(): void {
    // main.ts loads dotenv before constructing this manager so it can read
    // startup selectors. Remove any credential values it may have loaded;
    // only encrypted store entries become usable secrets below.
    if (!plaintextSecretEnvironmentCleared) {
      for (const envVarName of SECRET_ENV_KEYS) delete process.env[envVarName];
      plaintextSecretEnvironmentCleared = true;
    }

    // App config (.env in userData) takes precedence over system env vars.
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    this._loadDotEnv(userDataEnv, true);

    const fallbackPaths = [
      path.join(app.getAppPath(), ".env"), // Development
      path.join(process.resourcesPath, ".env"),
      path.join(process.resourcesPath, "app.asar.unpacked", ".env"),
      path.join(process.resourcesPath, "app", ".env"), // Legacy
    ];

    for (const envPath of fallbackPaths) {
      this._loadDotEnv(envPath, false);
    }
  }

  _loadDotEnv(envPath: string, override: boolean): void {
    try {
      const content = fs.readFileSync(envPath, "utf8");
      const parsed = require("dotenv").parse(content) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed)) {
        if (isSecretEnvKey(key)) continue;
        if (override || process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // Unreadable or absent .env: continue with system env and other sources.
    }
  }

  // Encryption initializes lazily. Probing it eagerly would touch the macOS
  // Keychain before any window is visible.
  async init(): Promise<void> {
    await this._stripPlaintextSecretsFromEnvFile();
    await this._loadAllSecrets();
  }

  _encryptionAvailable(): boolean {
    try {
      return secretCrypto.isAvailable();
    } catch {
      return false;
    }
  }

  _getSecureKeysDir(): string {
    return path.join(app.getPath("userData"), "secure-keys");
  }

  _getSecretFilePath(envVarName: string): string {
    return path.join(this._getSecureKeysDir(), `${envVarName}.enc`);
  }

  async _stripPlaintextSecretsFromEnvFile(): Promise<void> {
    const envPath = path.join(app.getPath("userData"), ".env");
    try {
      // An interrupted write from an older version may have left secret
      // assignments in its temporary file. It is never authoritative config.
      await fsPromises.rm(`${envPath}.tmp`, { force: true });
    } catch (error) {
      debugLogger.error(
        "Failed to remove temporary .env file",
        { code: (error as NodeJS.ErrnoException).code },
        "environment"
      );
      throw new Error("Could not remove the temporary .env file");
    }

    let content: string;
    try {
      content = await fsPromises.readFile(envPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      debugLogger.error(
        "Failed to read .env while removing plaintext secrets",
        { code: (error as NodeJS.ErrnoException).code },
        "environment"
      );
      throw new Error("Could not read .env to remove plaintext secrets");
    }
    const parsed = require("dotenv").parse(content) as Record<string, string>;
    if (!Object.keys(parsed).some(isSecretEnvKey)) return;
    const safeContent = Object.entries(parsed)
      .filter(([key]) => !isSecretEnvKey(key))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n");
    const tmpPath = `${envPath}.secure.tmp`;
    try {
      await fsPromises.writeFile(tmpPath, safeContent ? `${safeContent}\n` : "", { mode: 0o600 });
      await fsPromises.rename(tmpPath, envPath);
    } catch (error) {
      debugLogger.error(
        "Failed to remove plaintext secrets from .env",
        { code: (error as NodeJS.ErrnoException).code },
        "environment"
      );
      throw new Error("Could not remove plaintext secrets from .env");
    }
  }

  async _loadAllSecrets(): Promise<void> {
    await Promise.all(SECRET_KEYS.map((name) => this._loadSecretKey(name)));
  }

  async _loadSecretKey(envVarName: string): Promise<void> {
    const filePath = this._getSecretFilePath(envVarName);
    try {
      const buffer = await fsPromises.readFile(filePath);
      const { value, needsReencrypt } = secretCrypto.decrypt(buffer);
      process.env[envVarName] = value;
      if (needsReencrypt) await this._saveSecretKey(envVarName, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      delete process.env[envVarName];
      // Never log the value or the decrypted error detail — only the key
      // name and code; the user must re-enter the secret.
      debugLogger.error(
        "Failed to decrypt secret — user must re-enter",
        { key: envVarName, code: (error as NodeJS.ErrnoException).code },
        "environment"
      );
    }
  }

  async _saveSecretKey(envVarName: string, value: string): Promise<void> {
    if (!value) {
      await this._deleteSecretKey(envVarName);
      return;
    }

    const encrypted = secretCrypto.encrypt(value);
    const dir = this._getSecureKeysDir();
    await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(dir, 0o700);

    const filePath = this._getSecretFilePath(envVarName);
    const tmpPath = `${filePath}.tmp`;

    try {
      await fsPromises.writeFile(tmpPath, encrypted, { mode: 0o600 });
      await fsPromises.chmod(tmpPath, 0o600);
      await fsPromises.rename(tmpPath, filePath);
    } catch (error) {
      await fsPromises.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
    process.env[envVarName] = value;
  }

  async _deleteSecretKey(envVarName: string): Promise<void> {
    try {
      await fsPromises.unlink(this._getSecretFilePath(envVarName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    delete process.env[envVarName];
  }

  _writeEnvFileAtomic(envPath: string): Promise<unknown> {
    // Concurrent write+rename pairs share the same .env.tmp path, and the
    // loser's rename throws ENOENT (#903).
    envWriteQueue = envWriteQueue.catch(() => {}).then(() => this._writeEnvFile(envPath));
    return envWriteQueue;
  }

  async _writeEnvFile(envPath: string): Promise<void> {
    let envContent = "# OpenHercules Environment Variables\n";
    for (const key of PERSISTED_KEYS) {
      if (isSecretEnvKey(key)) continue;
      if (process.env[key]) {
        envContent += `${key}=${process.env[key]}\n`;
      }
    }
    const tmpPath = `${envPath}.tmp`;
    await fsPromises.writeFile(tmpPath, envContent, { encoding: "utf8", mode: 0o600 });
    await fsPromises.chmod(tmpPath, 0o600);
    await fsPromises.rename(tmpPath, envPath);
  }

  _getKey(envVarName: string): string {
    return process.env[envVarName] || "";
  }

  _saveKey(envVarName: SecretEnvKey, key: string): Promise<SaveKeyResult>;
  _saveKey(envVarName: string, key: string): SaveKeyResult;
  _saveKey(envVarName: string, key: string): SaveKeyResult | Promise<SaveKeyResult> {
    if (SECRET_KEYS.includes(envVarName as SecretEnvKey)) {
      if (key && !this._encryptionAvailable()) return Promise.resolve({ success: false });
      return this._trackSecretWrite(envVarName, () =>
        key ? this._saveSecretKey(envVarName, key) : this._deleteSecretKey(envVarName)
      );
    }
    if (key) {
      process.env[envVarName] = key;
    } else {
      delete process.env[envVarName];
    }
    return { success: true };
  }

  // Tracks one fire-and-forget secret write until it settles. Writes to the
  // same key run sequentially in call order — they share one .tmp path and
  // an older save must never overwrite a newer one's file — while different
  // keys stay independent. Failures are logged exactly as before and never
  // stall the chain; an older operation settling never unregisters a newer
  // one; _flushSecretWrites exposes every accepted lifetime.
  _trackSecretWrite(envVarName: string, start: () => Promise<void>): Promise<SaveKeyResult> {
    const previous = this._pendingSecretWrites.get(envVarName) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(start);
    const result = operation.then(
      () => ({ success: true }),
      (error) => {
        debugLogger.error(
          "Failed to persist encrypted secret",
          { key: envVarName, code: (error as NodeJS.ErrnoException).code },
          "environment"
        );
        return { success: false };
      }
    );
    const tracked = result.then(() => {});
    this._pendingSecretWrites.set(envVarName, tracked);
    void tracked.then(() => {
      if (this._pendingSecretWrites.get(envVarName) === tracked) {
        this._pendingSecretWrites.delete(envVarName);
      }
    });
    return result;
  }

  // Resolves when every secret write started so far has settled (written or
  // logged). Ordering guarantee for clearAllPersistedData and the observable
  // completion seam for tests.
  async _flushSecretWrites(): Promise<void> {
    await Promise.all([...this._pendingSecretWrites.values()]);
  }

  getCortiClientId(): string {
    return this._getKey("CORTI_CLIENT_ID");
  }

  saveCortiClientId(key: string): Promise<SaveKeyResult> {
    return this._saveKey("CORTI_CLIENT_ID", key) as Promise<SaveKeyResult>;
  }

  getCortiClientSecret(): string {
    return this._getKey("CORTI_CLIENT_SECRET");
  }

  saveCortiClientSecret(key: string): Promise<SaveKeyResult> {
    return this._saveKey("CORTI_CLIENT_SECRET", key) as Promise<SaveKeyResult>;
  }

  getCustomTranscriptionKey(): string {
    return this._getKey("CUSTOM_TRANSCRIPTION_API_KEY");
  }

  saveCustomTranscriptionKey(key: string): Promise<SaveKeyResult> {
    return this._saveKey("CUSTOM_TRANSCRIPTION_API_KEY", key) as Promise<SaveKeyResult>;
  }

  getCleanupCustomKey(): string {
    return this._getKey("CUSTOM_CLEANUP_API_KEY");
  }

  saveCleanupCustomKey(key: string): Promise<SaveKeyResult> {
    return this._saveKey("CUSTOM_CLEANUP_API_KEY", key) as Promise<SaveKeyResult>;
  }

  // Enterprise providers — AWS Bedrock
  getBedrockRegion(): string {
    return this._getKey("BEDROCK_REGION");
  }
  saveBedrockRegion(value: string): SaveKeyResult {
    return this._saveKey("BEDROCK_REGION", value);
  }
  getBedrockProfile(): string {
    return this._getKey("BEDROCK_PROFILE");
  }
  saveBedrockProfile(value: string): SaveKeyResult {
    return this._saveKey("BEDROCK_PROFILE", value);
  }
  getBedrockAccessKeyId(): string {
    return this._getKey("BEDROCK_ACCESS_KEY_ID");
  }
  saveBedrockAccessKeyId(key: string): Promise<SaveKeyResult> {
    return this._saveKey("BEDROCK_ACCESS_KEY_ID", key) as Promise<SaveKeyResult>;
  }
  getBedrockSecretAccessKey(): string {
    return this._getKey("BEDROCK_SECRET_ACCESS_KEY");
  }
  saveBedrockSecretAccessKey(key: string): Promise<SaveKeyResult> {
    return this._saveKey("BEDROCK_SECRET_ACCESS_KEY", key) as Promise<SaveKeyResult>;
  }
  getBedrockSessionToken(): string {
    return this._getKey("BEDROCK_SESSION_TOKEN");
  }
  saveBedrockSessionToken(key: string): Promise<SaveKeyResult> {
    return this._saveKey("BEDROCK_SESSION_TOKEN", key) as Promise<SaveKeyResult>;
  }

  // Enterprise providers — Azure OpenAI
  getAzureEndpoint(): string {
    return this._getKey("AZURE_OPENAI_ENDPOINT");
  }
  saveAzureEndpoint(value: string): SaveKeyResult {
    return this._saveKey("AZURE_OPENAI_ENDPOINT", value);
  }
  getAzureApiKey(): string {
    return this._getKey("AZURE_OPENAI_API_KEY");
  }
  saveAzureApiKey(key: string): Promise<SaveKeyResult> {
    return this._saveKey("AZURE_OPENAI_API_KEY", key) as Promise<SaveKeyResult>;
  }
  getAzureDeployment(): string {
    return this._getKey("AZURE_OPENAI_DEPLOYMENT");
  }
  saveAzureDeployment(value: string): SaveKeyResult {
    return this._saveKey("AZURE_OPENAI_DEPLOYMENT", value);
  }
  getAzureApiVersion(): string {
    return this._getKey("AZURE_OPENAI_API_VERSION");
  }
  saveAzureApiVersion(value: string): SaveKeyResult {
    return this._saveKey("AZURE_OPENAI_API_VERSION", value);
  }

  // Enterprise providers — GCP Vertex AI
  getVertexProject(): string {
    return this._getKey("VERTEX_PROJECT");
  }
  saveVertexProject(value: string): SaveKeyResult {
    return this._saveKey("VERTEX_PROJECT", value);
  }
  getVertexLocation(): string {
    return this._getKey("VERTEX_LOCATION");
  }
  saveVertexLocation(value: string): SaveKeyResult {
    return this._saveKey("VERTEX_LOCATION", value);
  }
  getVertexApiKey(): string {
    return this._getKey("VERTEX_API_KEY");
  }
  saveVertexApiKey(key: string): Promise<SaveKeyResult> {
    return this._saveKey("VERTEX_API_KEY", key) as Promise<SaveKeyResult>;
  }

  getDictationKey(): string {
    return this._getKey("DICTATION_KEY");
  }

  saveDictationKey(key: string): SaveKeyResult {
    const result = this._saveKey("DICTATION_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getVoiceAgentKey(): string {
    return this._getKey("VOICE_AGENT_KEY");
  }

  saveVoiceAgentKey(key: string): Promise<SaveKeyResult> {
    return this._saveKey("VOICE_AGENT_KEY", key) as Promise<SaveKeyResult>;
  }

  getTranslationKey(): string {
    return this._getKey("TRANSLATION_KEY");
  }

  saveTranslationKey(key: string): Promise<SaveKeyResult> {
    return this._saveKey("TRANSLATION_KEY", key) as Promise<SaveKeyResult>;
  }

  getMeetingKey(): string {
    return this._getKey("MEETING_KEY");
  }

  saveMeetingKey(key: string): SaveKeyResult {
    return this._saveKey("MEETING_KEY", key);
  }

  getActivationMode(): "push" | "tap" {
    const mode = this._getKey("ACTIVATION_MODE");
    return mode === "push" ? "push" : "tap";
  }

  saveActivationMode(mode: string): SaveKeyResult {
    const validMode = mode === "push" ? "push" : "tap";
    const result = this._saveKey("ACTIVATION_MODE", validMode);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getFloatingIconAutoHide(): boolean {
    return this._getKey("FLOATING_ICON_AUTO_HIDE") === "true";
  }

  saveFloatingIconAutoHide(enabled: boolean): SaveKeyResult {
    const result = this._saveKey("FLOATING_ICON_AUTO_HIDE", String(enabled));
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getStartMinimized(): boolean {
    return this._getKey("START_MINIMIZED") === "true";
  }

  saveStartMinimized(enabled: boolean): SaveKeyResult {
    const result = this._saveKey("START_MINIMIZED", String(enabled));
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getPanelStartPosition(): "bottom-right" | "center" | "bottom-left" {
    const v = this._getKey("PANEL_START_POSITION");
    if (v === "bottom-right" || v === "center" || v === "bottom-left") return v;
    return "bottom-right";
  }

  savePanelStartPosition(position: string): SaveKeyResult {
    const result = this._saveKey("PANEL_START_POSITION", position);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getUiLanguage(fallbackLanguage = ""): string {
    const language = this._getKey("UI_LANGUAGE") || fallbackLanguage;
    return language ? normalizeUiLanguage(language) : "";
  }

  saveUiLanguage(language: string): SaveKeyResult & { language: string } {
    const normalized = normalizeUiLanguage(language);
    const result = this._saveKey("UI_LANGUAGE", normalized);
    this.saveAllKeysToEnvFile().catch(() => {});
    return { ...result, language: normalized };
  }

  async saveAllKeysToEnvFile(): Promise<{ success: boolean; path: string }> {
    const envPath = path.join(app.getPath("userData"), ".env");
    await this._writeEnvFileAtomic(envPath);
    require("dotenv").config({ path: envPath });
    return { success: true, path: envPath };
  }

  _deletePersistedEnvValues(): void {
    for (const envVarName of PERSISTED_KEYS) {
      delete process.env[envVarName];
    }
    for (const envVarName of SECRET_ENV_KEYS) delete process.env[envVarName];
  }

  async clearAllPersistedData(): Promise<{ success: boolean }> {
    this._deletePersistedEnvValues();

    // A save fired before the clear must not land after the rm and
    // resurrect its .enc file. A write settling during that wait re-runs
    // _saveSecretKey, which re-sets its env value — so the values are
    // dropped once more after every write has settled, before the rm.
    await this._flushSecretWrites();
    this._deletePersistedEnvValues();

    await Promise.all([
      fsPromises.rm(path.join(app.getPath("userData"), ".env"), { force: true }),
      fsPromises.rm(this._getSecureKeysDir(), { recursive: true, force: true }),
    ]);
    return { success: true };
  }

  // Removes a single key's line from .env, preserving every other line
  // verbatim. saveAllKeysToEnvFile() would instead regenerate the file from
  // PERSISTED_KEYS, dropping hand-added lines (e.g. OPENHERCULES_LOG_LEVEL) and
  // materializing session/shell env values into the file.
  removeKeyFromEnvFile(key: string): Promise<unknown> {
    const envPath = path.join(app.getPath("userData"), ".env");
    envWriteQueue = envWriteQueue.catch(() => {}).then(() => this._removeKeyLine(envPath, key));
    return envWriteQueue;
  }

  async _removeKeyLine(envPath: string, key: string): Promise<void> {
    let content: string;
    try {
      content = await fsPromises.readFile(envPath, "utf8");
    } catch {
      return; // No .env — nothing to remove.
    }
    const keyLine = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const lines = content.split("\n");
    const kept = lines.filter((line) => !keyLine.test(line));
    if (kept.length === lines.length) return;
    const tmpPath = `${envPath}.tmp`;
    await fsPromises.writeFile(tmpPath, kept.join("\n"), "utf8");
    await fsPromises.rename(tmpPath, envPath);
  }
}

// Generate the uniform BYOK key accessors (getOpenAIKey/saveOpenAIKey/…) from
// the shared manifest so each provider is defined in exactly one place.
// The generated accessors are catalog-driven: the `as const` manifest turns
// every get/save name into a literal, so the surface below is exactly the
// methods the loop attaches (no free string index).
export type ByokGetterName = (typeof BYOK_API_KEYS)[number]["get"];
export type ByokSetterName = (typeof BYOK_API_KEYS)[number]["save"];

export type ByokAccessorSurface = {
  [name in ByokGetterName]: () => string;
} & {
  [name in ByokSetterName]: (key: string) => Promise<SaveKeyResult>;
};

export type EnvironmentManagerWithByok = EnvironmentManager & ByokAccessorSurface;

const managerPrototype = EnvironmentManager.prototype as typeof EnvironmentManager.prototype &
  Record<string, unknown>;

for (const k of BYOK_API_KEYS) {
  managerPrototype[k.get] = function (this: EnvironmentManager) {
    return this._getKey(k.env);
  };
  managerPrototype[k.save] = function (this: EnvironmentManager, key = "") {
    return this._saveKey(k.env, key);
  };
}

// Dual-export contract: the class itself plus the named export so both the
// legacy `require("./environment")` call sites and emitted cross-module
// imports construct the same constructor.
module.exports = EnvironmentManager;
module.exports.EnvironmentManager = EnvironmentManager;
