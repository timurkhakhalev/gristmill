const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const { pipeline } = require("stream/promises");
const debugLogger = require("./debugLogger.js");
const { runSystemTar } = require("./systemTar.js");
const {
  downloadFile,
  createDownloadSignal,
  createDownloadInProgressError,
  cleanupStaleDownloads,
  checkDiskSpace,
} = require("./downloadUtils.js");
import { fetchJson } from "./downloadUtils.js";
import { ParakeetServerManager } from "./parakeetServer.js";
const { getModelsDirForService } = require("./modelDirUtils.js");
import { assertParakeetSupported, getParakeetCapability } from "./parakeetCapability.js";

const modelRegistryData = require("../models/modelRegistryData.json");
import {
  getModelRuntime,
  getRequiredModelFiles,
  isSherpaLocalProvider,
} from "./parakeetModelInfo.js";

interface ParakeetModelRegistryEntry {
  downloadUrl: string;
  manifestUrl?: string;
  sizeMb?: number;
  expectedSizeBytes?: number;
  language?: string;
  supportedLanguages?: string[];
  extractDir: string;
}

interface ParakeetModelConfig {
  url: string;
  manifestUrl?: string;
  size: number;
  expectedSizeBytes?: number;
  language?: string;
  supportedLanguages: string[];
  extractDir: string;
}

function getParakeetModelConfig(modelName: string): ParakeetModelConfig | null {
  const modelInfo = (modelRegistryData.parakeetModels as Record<string, ParakeetModelRegistryEntry>)[modelName];
  if (!modelInfo) return null;
  return {
    url: modelInfo.downloadUrl,
    manifestUrl: modelInfo.manifestUrl,
    size: modelInfo.expectedSizeBytes || (modelInfo.sizeMb as number) * 1_000_000,
    expectedSizeBytes: modelInfo.expectedSizeBytes,
    language: modelInfo.language,
    supportedLanguages: modelInfo.supportedLanguages || [],
    extractDir: modelInfo.extractDir,
  };
}

function getValidModelNames(): string[] {
  return Object.keys(modelRegistryData.parakeetModels);
}

interface DownloadProgressEvent {
  type: "progress" | "installing" | "complete";
  model: string;
  downloaded_bytes?: number;
  total_bytes?: number;
  percentage: number;
}

interface ParakeetDownloadProcess {
  abort(): void;
  model: string;
  phase: "progress" | "installing";
  percentage: number;
  downloadedBytes: number;
  totalBytes: number;
}

type AudioInput =
  | Buffer
  | ArrayBuffer
  | ArrayBufferView
  | string
  | { buffer: ArrayBuffer | ArrayBufferView; byteLength: number; byteOffset?: number };

export class ParakeetManager {
  currentDownloadProcess: ParakeetDownloadProcess | null = null;
  isInitialized = false;
  serverManager = new ParakeetServerManager();

  getModelsDir(): string {
    return getModelsDirForService("parakeet");
  }

  validateModelName(modelName: string): boolean {
    const validModels = getValidModelNames();
    if (!validModels.includes(modelName)) {
      throw new Error(
        `Invalid Parakeet model: ${modelName}. Valid models: ${validModels.join(", ")}`
      );
    }
    return true;
  }

  getModelPath(modelName: string): string {
    this.validateModelName(modelName);
    return path.join(this.getModelsDir(), modelName);
  }

  isModelDownloaded(modelName: string): boolean {
    return this.serverManager.isModelDownloaded(modelName);
  }

  // Cohere models keep their weights in encoder.int8.onnx.data; transducers in
  // encoder.int8.onnx. Used as the reported on-disk size of a model.
  _getModelWeightsSize(modelDir: string): number {
    for (const file of ["encoder.int8.onnx.data", "encoder.int8.onnx"]) {
      try {
        return fs.statSync(path.join(modelDir, file)).size;
      } catch {}
    }
    return 0;
  }

  async initializeAtStartup(settings: Record<string, unknown> = {}): Promise<void> {
    const startTime = Date.now();

    try {
      this.isInitialized = true;

      await cleanupStaleDownloads(this.getModelsDir());

      await this.logDependencyStatus();

      const localTranscriptionProvider = settings.localTranscriptionProvider as string | undefined;
      const parakeetModel = settings.parakeetModel as string | undefined;
      const language = settings.language as string | undefined;
      const capability = getParakeetCapability();

      if (
        capability.supported &&
        isSherpaLocalProvider(localTranscriptionProvider) &&
        parakeetModel &&
        this.serverManager.isAvailable(getModelRuntime(parakeetModel))
      ) {
        if (this.serverManager.isModelDownloaded(parakeetModel)) {
          debugLogger.info("Pre-warming parakeet server", { model: parakeetModel });

          try {
            const serverStartTime = Date.now();
            await this.serverManager.startServer(parakeetModel, language);
            debugLogger.info("Parakeet server pre-warmed successfully", {
              model: parakeetModel,
              startupTimeMs: Date.now() - serverStartTime,
            });
          } catch (err) {
            debugLogger.warn("Parakeet server pre-warm failed (will start on first use)", {
              error: (err as Error).message,
              model: parakeetModel,
            });
          }
        } else {
          debugLogger.debug("Skipping parakeet server pre-warm: model not downloaded", {
            model: parakeetModel,
          });
        }
      } else {
        debugLogger.debug("Skipping parakeet server pre-warm", {
          reason: !capability.supported
            ? capability.message
            : !isSherpaLocalProvider(localTranscriptionProvider)
              ? "provider not sherpa-based"
              : !parakeetModel
                ? "no model selected"
                : "server binary not available",
        });
      }
    } catch (error) {
      debugLogger.warn("Parakeet initialization error", { error: (error as Error).message });
      this.isInitialized = true;
    }

    debugLogger.info("Parakeet initialization complete", {
      totalTimeMs: Date.now() - startTime,
      binaryAvailable: this.serverManager.hasAnyWsBinary(),
    });
  }

  async logDependencyStatus(): Promise<void> {
    const status: {
      sherpaOnnx: { available: boolean; path: string | null };
      models: Array<{ name: string; size: string }>;
    } = {
      sherpaOnnx: {
        available: this.serverManager.hasAnyWsBinary(),
        path:
          this.serverManager.getBinaryPath("offline") || this.serverManager.getBinaryPath("online"),
      },
      models: [],
    };

    for (const modelName of getValidModelNames()) {
      const modelPath = this.getModelPath(modelName);
      if (this.serverManager.isModelDownloaded(modelName)) {
        status.models.push({
          name: modelName,
          size: `${Math.round(this._getModelWeightsSize(modelPath) / (1024 * 1024))}MB`,
        });
      }
    }

    debugLogger.info("Parakeet dependency check", status);

    const binaryStatus = status.sherpaOnnx.available
      ? `✓ ${status.sherpaOnnx.path}`
      : "✗ Not found";
    const modelsStatus =
      status.models.length > 0
        ? status.models.map((m) => `${m.name}`).join(", ")
        : "None downloaded";

    debugLogger.info(`[Parakeet] sherpa-onnx: ${binaryStatus}`);
    debugLogger.info(`[Parakeet] Models: ${modelsStatus}`);
  }

  async checkInstallation(): Promise<Record<string, unknown>> {
    const binaryPath =
      this.serverManager.getBinaryPath("offline") || this.serverManager.getBinaryPath("online");
    const capability = getParakeetCapability();

    if (!capability.supported) {
      return {
        installed: !!binaryPath,
        working: false,
        ...capability,
      };
    }

    if (!binaryPath) {
      return { installed: false, working: false, supported: true };
    }

    return { installed: true, working: true, supported: true, path: binaryPath };
  }

  async startServer(modelName: string, language?: string | null): Promise<Record<string, unknown>> {
    this.validateModelName(modelName);
    const capability = getParakeetCapability();
    if (!capability.supported) {
      return { success: false, code: capability.code, reason: capability.message };
    }
    return this.serverManager.startServer(modelName, language);
  }

  async stopServer(): Promise<void> {
    await this.serverManager.stopServer();
  }

  getServerStatus(): Record<string, unknown> {
    return this.serverManager.getServerStatus();
  }

  supportsOnlineStreaming(modelName: string): boolean {
    return getModelRuntime(modelName) === "online";
  }

  async createOnlineStream(modelName: string, options: Record<string, unknown> = {}): Promise<unknown> {
    this.validateModelName(modelName);
    assertParakeetSupported();
    const started = await this.serverManager.startServer(modelName);
    if (!started.success) {
      throw new Error(started.reason || "Failed to start parakeet streaming server");
    }
    return this.serverManager.createOnlineStream(options);
  }

  async transcribeLocalParakeet(audioBlob: AudioInput, options: Record<string, unknown> = {}): Promise<unknown> {
    const model = (options.model as string) || "parakeet-tdt-0.6b-v3";
    assertParakeetSupported();
    const serverAvailable = this.serverManager.isAvailable(getModelRuntime(model));

    debugLogger.logSTTPipeline("transcribeLocalParakeet - start", {
      options,
      audioBlobType: audioBlob?.constructor?.name,
      audioBlobSize:
        (audioBlob as { byteLength?: number })?.byteLength ||
        (audioBlob as { size?: number })?.size ||
        0,
      serverAvailable,
    });

    if (!serverAvailable) {
      throw new Error(
        "sherpa-onnx binary not found. Please ensure the app is installed correctly."
      );
    }

    if (!this.serverManager.isModelDownloaded(model)) {
      throw new Error(
        `Parakeet model "${model}" not downloaded. Please download it from Settings.`
      );
    }

    let audioBuffer: Buffer;
    if (Buffer.isBuffer(audioBlob)) {
      audioBuffer = audioBlob;
    } else if (ArrayBuffer.isView(audioBlob)) {
      audioBuffer = Buffer.from(audioBlob.buffer, audioBlob.byteOffset, audioBlob.byteLength);
    } else if (audioBlob instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(audioBlob);
    } else if (typeof audioBlob === "string") {
      audioBuffer = Buffer.from(audioBlob, "base64");
    } else if (audioBlob && audioBlob.buffer && typeof audioBlob.byteLength === "number") {
      audioBuffer = Buffer.from(
        audioBlob.buffer as ArrayBuffer,
        audioBlob.byteOffset || 0,
        audioBlob.byteLength
      );
    } else {
      throw new Error(`Unsupported audio data type: ${typeof audioBlob}`);
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Audio buffer is empty - no audio data received");
    }

    debugLogger.logSTTPipeline("transcribeLocalParakeet - processing", {
      bufferSize: audioBuffer.length,
      model,
    });

    const startTime = Date.now();
    const result = (await this.serverManager.transcribe(audioBuffer, {
      modelName: model,
      language: options.language as string | undefined,
      signal: options.signal as AbortSignal | undefined,
    })) as { text?: string; truncated?: boolean; elapsed?: number };
    const elapsed = Date.now() - startTime;

    debugLogger.logSTTPipeline("transcribeLocalParakeet - completed", {
      elapsed,
      textLength: result.text?.length || 0,
    });

    return this.parseParakeetResult(result);
  }

  parseParakeetResult(output: unknown): {
    success: boolean;
    text?: string;
    error?: string;
    code?: string;
    message?: string;
    warning?: string;
  } {
    const record = output as { text?: unknown; truncated?: unknown } | null | undefined;
    debugLogger.debug("parseParakeetResult", {
      hasOutput: !!output,
      hasText: !!record?.text,
      textLength: (record?.text as string | undefined)?.length || 0,
    });

    // Missing or entirely truncated output is a broken decode. Only a completed
    // empty transcript is a no-speech outcome.
    if (
      !output ||
      typeof record?.text !== "string" ||
      (record?.truncated && !(record.text as string).trim())
    ) {
      return {
        success: false,
        error: "invalid_response",
        message: "Transcription engine returned an unexpected response",
      };
    }

    const text = (record?.text as string).trim();

    if (!text) {
      return { success: false, code: "NO_SPEECH_DETECTED", message: "No audio detected" };
    }

    // Surfaced by the renderer as a partial-transcription warning toast.
    return record?.truncated
      ? { success: true, text, warning: "truncated" }
      : { success: true, text };
  }

  async downloadParakeetModel(
    modelName: string,
    progressCallback: ((event: DownloadProgressEvent) => void) | null = null
  ): Promise<Record<string, unknown>> {
    this.validateModelName(modelName);
    assertParakeetSupported();
    const modelConfig = getParakeetModelConfig(modelName) as ParakeetModelConfig;

    const modelPath = this.getModelPath(modelName);
    const modelsDir = this.getModelsDir();

    if (this.serverManager.isModelDownloaded(modelName)) {
      return { model: modelName, downloaded: true, path: modelPath, success: true };
    }

    if (this.currentDownloadProcess) {
      throw createDownloadInProgressError(modelName, this.currentDownloadProcess.model);
    }

    const archivePath = path.join(modelsDir, `${modelName}.tar.bz2`);
    const { signal, abort } = createDownloadSignal();
    const downloadProcess: ParakeetDownloadProcess = {
      abort,
      model: modelName,
      phase: "progress",
      percentage: 0,
      downloadedBytes: 0,
      totalBytes: 0,
    };
    this.currentDownloadProcess = downloadProcess;

    try {
      await fsPromises.mkdir(modelsDir, { recursive: true });

      const spaceCheck = await checkDiskSpace(modelsDir, modelConfig.size * 2.5);
      if (!spaceCheck.ok) {
        throw new Error(
          `Not enough disk space to download and extract model. Need ~${Math.round((modelConfig.size * 2.5) / 1_000_000)}MB, ` +
            `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
      }

      let archiveReady = false;
      try {
        const stats = await fsPromises.stat(archivePath);
        // A visibly truncated leftover would just fail extraction forever.
        if (stats.size >= modelConfig.size * 0.9) {
          archiveReady = true;
          debugLogger.info("Reusing existing archive from previous attempt", {
            archivePath,
            size: stats.size,
          });
        } else if (stats.size > 0) {
          await fsPromises.unlink(archivePath).catch(() => {});
        }
      } catch {}

      if (!archiveReady) {
        await downloadFile(modelConfig.url, archivePath, {
          timeout: 600000,
          signal,
          onProgress: (downloadedBytes: number, totalBytes: number) => {
            downloadProcess.percentage =
              totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
            downloadProcess.downloadedBytes = downloadedBytes;
            downloadProcess.totalBytes = totalBytes;
            if (progressCallback) {
              progressCallback({
                type: "progress",
                model: modelName,
                downloaded_bytes: downloadedBytes,
                total_bytes: totalBytes,
                percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
              });
            }
          },
        });
      }

      downloadProcess.phase = "installing" as const;
      downloadProcess.percentage = 100;
      if (progressCallback) {
        progressCallback({ type: "installing", model: modelName, percentage: 100 });
      }

      const MAX_EXTRACT_RETRIES = 2;
      for (let attempt = 1; attempt <= MAX_EXTRACT_RETRIES; attempt++) {
        try {
          await this._extractModel(archivePath, modelName);
          break;
        } catch (extractError) {
          debugLogger.warn("Model extraction failed", {
            attempt,
            maxAttempts: MAX_EXTRACT_RETRIES,
            error: (extractError as Error).message,
          });
          if (attempt >= MAX_EXTRACT_RETRIES) {
            // The archive is the prime suspect; drop it so the next attempt re-downloads.
            await fsPromises.unlink(archivePath).catch(() => {});
            const err = new Error(`Model installation failed: ${(extractError as Error).message}`);

            throw err;
          }
        }
      }
      await fsPromises.unlink(archivePath).catch(() => {});

      if (progressCallback) {
        progressCallback({ type: "complete", model: modelName, percentage: 100 });
      }

      // Pre-warm the downloaded model, but never hijack a server that is already
      // serving (or starting) another model — e.g. mid-dictation.
      const serverStatus = this.serverManager.getServerStatus();
      if (
        this.serverManager.isAvailable(getModelRuntime(modelName)) &&
        !serverStatus.running &&
        !serverStatus.starting
      ) {
        this.serverManager.startServer(modelName).catch((err: Error) => {
          debugLogger.warn("Post-download server pre-warm failed (non-fatal)", {
            error: err.message,
            model: modelName,
          });
        });
      }

      // Optional provenance: one request after a fresh install, never on model load.
      // Hugging Face counts this JSON request for NeMo repositories.
      if (!archiveReady && !signal.aborted && modelConfig.manifestUrl) {
        this._saveModelManifest(modelConfig, modelPath).catch((error) => {
          debugLogger.debug("Optional model manifest unavailable", {
            modelName,
            error: error.message,
          });
        });
      }

      return { model: modelName, downloaded: true, path: modelPath, success: true };
    } catch (error) {
      if ((error as { isAbort?: boolean }).isAbort) {
        await fsPromises.unlink(archivePath).catch(() => {});
        throw Object.assign(new Error("Download interrupted by user"), {
          code: "DOWNLOAD_CANCELLED",
        });
      }
      throw error;
    } finally {
      if (this.currentDownloadProcess === downloadProcess) {
        this.currentDownloadProcess = null;
      }
    }
  }

  async _saveModelManifest(modelConfig: ParakeetModelConfig, modelPath: string): Promise<void> {
    const manifest = (await fetchJson<{
      archive?: unknown;
      extract_dir?: unknown;
      archive_bytes?: unknown;
      archive_sha256?: unknown;
    }>(modelConfig.manifestUrl as string, {
      // Keep the default session's cookies off a third-party host, and make sure
      // the request reaches the network — a cache hit would not be counted.
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    }));
    if (
      manifest?.archive !== path.posix.basename(new URL(modelConfig.url).pathname) ||
      manifest.extract_dir !== modelConfig.extractDir ||
      // Only `expectedSizeBytes` is the archive's true size; `sizeMb` describes the
      // extracted model, so a model without it simply skips this comparison.
      (modelConfig.expectedSizeBytes && manifest.archive_bytes !== modelConfig.expectedSizeBytes) ||
      !/^[a-f0-9]{64}$/.test(String(manifest.archive_sha256))
    ) {
      throw new Error("Manifest does not match the installed model");
    }
    // Never recreate a deleted model directory or overwrite an existing sidecar.
    await fsPromises.writeFile(
      path.join(modelPath, "download-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx" }
    );
  }

  async _extractModel(archivePath: string, modelName: string): Promise<void> {
    const modelsDir = this.getModelsDir();
    const modelConfig = getParakeetModelConfig(modelName) as ParakeetModelConfig;
    const extractDir = path.join(modelsDir, `temp-extract-${modelName}`);

    try {
      await fsPromises.mkdir(extractDir, { recursive: true });
      debugLogger.info("Extracting parakeet archive", { archivePath, extractDir });
      await this._runTarExtract(archivePath, extractDir);
      debugLogger.info("Tar extraction completed", { extractDir });

      const extractedDir = path.join(extractDir, modelConfig.extractDir);
      const targetDir = this.getModelPath(modelName);

      if (fs.existsSync(extractedDir)) {
        if (fs.existsSync(targetDir)) {
          await fsPromises.rm(targetDir, { recursive: true, force: true });
        }
        await fsPromises.rename(extractedDir, targetDir);
      } else {
        const entries = await fsPromises.readdir(extractDir);
        debugLogger.warn("Expected extract directory not found, searching alternatives", {
          expected: modelConfig.extractDir,
          found: entries,
        });
        let modelDir: string | null = null;

        for (const entry of entries) {
          const entryPath = path.join(extractDir, entry);
          const stat = await fsPromises.stat(entryPath);
          if (
            stat.isDirectory() &&
            getRequiredModelFiles(modelName).every((file) =>
              fs.existsSync(path.join(entryPath, file))
            )
          ) {
            modelDir = entry;
            break;
          }
        }

        if (modelDir) {
          if (fs.existsSync(targetDir)) {
            await fsPromises.rm(targetDir, { recursive: true, force: true });
          }
          await fsPromises.rename(path.join(extractDir, modelDir), targetDir);
        } else {
          throw new Error(
            `Could not find model directory in extracted archive. ` +
              `Expected "${modelConfig.extractDir}", found: [${entries.join(", ")}]`
          );
        }
      }

      const missing = getRequiredModelFiles(modelName).filter(
        (f) => !fs.existsSync(path.join(targetDir, f))
      );
      if (missing.length > 0) {
        throw new Error(`Extracted model is missing required files: ${missing.join(", ")}`);
      }

      await fsPromises.rm(extractDir, { recursive: true, force: true });

      debugLogger.info("Parakeet model extracted", { modelName, targetDir });
    } catch (error) {
      try {
        await fsPromises.rm(extractDir, { recursive: true, force: true });
      } catch {}
      throw error;
    }
  }

  async _runTarExtract(archivePath: string, extractDir: string): Promise<void> {
    try {
      await this._runSystemTar(archivePath, extractDir);
      return;
    } catch (err) {
      debugLogger.debug("System tar failed, falling back to JS extraction", {
        error: (err as Error).message,
      });
    }

    const unbzip2 = require("unbzip2-stream");
    const tar = require("tar");
    await pipeline(fs.createReadStream(archivePath), unbzip2(), tar.x({ cwd: extractDir }));
  }

  _runSystemTar(archivePath: string, extractDir: string): Promise<unknown> {
    return runSystemTar(archivePath, extractDir);
  }

  async cancelDownload(): Promise<Record<string, unknown>> {
    if (this.currentDownloadProcess) {
      if (this.currentDownloadProcess.phase === "installing") {
        return {
          success: false,
          error: "Model installation cannot be cancelled once extraction has started",
          code: "INSTALLATION_IN_PROGRESS",
        };
      }
      this.currentDownloadProcess.abort();
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async checkModelStatus(modelName: string): Promise<Record<string, unknown>> {
    const modelPath = this.getModelPath(modelName);
    const activeDownload = this.currentDownloadProcess?.model === modelName;
    const downloadStatus = {
      isDownloading: activeDownload,
      isInstalling:
        activeDownload && (this.currentDownloadProcess as ParakeetDownloadProcess).phase === "installing",
      downloadProgress: activeDownload ? (this.currentDownloadProcess as ParakeetDownloadProcess).percentage : 0,
      downloadedBytes: activeDownload
        ? (this.currentDownloadProcess as ParakeetDownloadProcess).downloadedBytes
        : 0,
      totalBytes: activeDownload ? (this.currentDownloadProcess as ParakeetDownloadProcess).totalBytes : 0,
    };

    if (this.serverManager.isModelDownloaded(modelName)) {
      const sizeBytes = this._getModelWeightsSize(modelPath);
      return {
        model: modelName,
        downloaded: true,
        path: modelPath,
        size_bytes: sizeBytes,
        size_mb: Math.round(sizeBytes / (1024 * 1024)),
        success: true,
        ...downloadStatus,
      };
    }

    return { model: modelName, downloaded: false, success: true, ...downloadStatus };
  }

  async listParakeetModels(): Promise<{ models: unknown[]; cache_dir: string; success: boolean }> {
    const models = getValidModelNames();
    const modelInfo = [];

    for (const model of models) {
      const status = await this.checkModelStatus(model);
      modelInfo.push(status);
    }

    return {
      models: modelInfo,
      cache_dir: this.getModelsDir(),
      success: true,
    };
  }

  async deleteParakeetModel(modelName: string): Promise<Record<string, unknown>> {
    const modelPath = this.getModelPath(modelName);

    if (fs.existsSync(modelPath)) {
      try {
        const freedBytes = this._getModelWeightsSize(modelPath);

        fs.rmSync(modelPath, { recursive: true, force: true });

        return {
          model: modelName,
          deleted: true,
          freed_bytes: freedBytes,
          freed_mb: Math.round(freedBytes / (1024 * 1024)),
          success: true,
        };
      } catch (error) {
        return { model: modelName, deleted: false, error: (error as Error).message, success: false };
      }
    }

    return { model: modelName, deleted: false, error: "Model not found", success: false };
  }

  async deleteAllParakeetModels(): Promise<Record<string, unknown>> {
    const modelsDir = this.getModelsDir();
    let totalFreed = 0;
    let deletedCount = 0;

    try {
      if (!fs.existsSync(modelsDir)) {
        return { success: true, deleted_count: 0, freed_bytes: 0, freed_mb: 0 };
      }

      const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(modelsDir, entry.name);
          try {
            totalFreed += this._getModelWeightsSize(dirPath);

            fs.rmSync(dirPath, { recursive: true, force: true });
            deletedCount++;
          } catch {}
        }
      }

      return {
        success: true,
        deleted_count: deletedCount,
        freed_bytes: totalFreed,
        freed_mb: Math.round(totalFreed / (1024 * 1024)),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async getDiagnostics(): Promise<Record<string, unknown>> {
    const diagnostics: Record<string, unknown> & {
      sherpaOnnx: { available: boolean; path: string | null };
      models: string[];
    } = {
      platform: process.platform,
      arch: process.arch,
      resourcesPath: process.resourcesPath || null,
      isPackaged: !!process.resourcesPath && !process.resourcesPath.includes("node_modules"),
      sherpaOnnx: { available: false, path: null },
      modelsDir: this.getModelsDir(),
      models: [],
    };
    const binaryPath =
      this.serverManager.getBinaryPath("offline") || this.serverManager.getBinaryPath("online");
    if (binaryPath) {
      diagnostics.sherpaOnnx = { available: true, path: binaryPath };
    }

    try {
      const modelsDir = this.getModelsDir();
      if (fs.existsSync(modelsDir)) {
        const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
        diagnostics.models = entries
          .filter((e: { isDirectory(): boolean; name: string }) => e.isDirectory() && this.serverManager.isModelDownloaded(e.name))
          .map((e: { name: string }) => e.name);
      }
    } catch {}

    return diagnostics;
  }
}

