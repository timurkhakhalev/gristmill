const { app } = require("electron");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const debugLogger = require("./debugLogger.js");
const { ensureWhisperVadModel } = require("./whisperVadModel.js");
const {
  downloadFile,
  createDownloadSignal,
  createDownloadInProgressError,
  validateFileSize,
  cleanupStaleDownloads,
  checkDiskSpace,
} = require("./downloadUtils.js");
import { WhisperServerManager } from "./whisperServer.js";
const { createAbortError } = require("./abortError.js");
const { getModelsDirForService } = require("./modelDirUtils.js");

const modelRegistryData = require("../models/modelRegistryData.json");

const CACHE_TTL_MS = 30000;

interface WhisperModelRegistryEntry {
  downloadUrl: string;
  fileName: string;
  sizeMb?: number;
  expectedSizeBytes?: number;
}

interface WhisperModelConfig {
  url: string;
  size: number;
  fileName: string;
}

function getWhisperModelConfig(modelName: string): WhisperModelConfig | null {
  const modelInfo = (modelRegistryData.whisperModels as Record<string, WhisperModelRegistryEntry>)[modelName];
  if (!modelInfo) return null;
  return {
    url: modelInfo.downloadUrl,
    size: modelInfo.expectedSizeBytes || (modelInfo.sizeMb as number) * 1_000_000,
    fileName: modelInfo.fileName,
  };
}

function getValidModelNames(): string[] {
  return Object.keys(modelRegistryData.whisperModels);
}

export interface RewarmDecisionInput {
  isRemote: boolean;
  modelName: string | null;
  transcribing: boolean;
  rewarmInFlight: boolean;
}

export function shouldRewarmOnWake({
  isRemote,
  modelName,
  transcribing,
  rewarmInFlight,
}: RewarmDecisionInput): boolean {
  return !isRemote && !!modelName && !transcribing && !rewarmInFlight;
}

interface WhisperDownloadProcess {
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

interface DownloadProgressEvent {
  type: "progress" | "installing" | "complete";
  model: string;
  downloaded_bytes?: number;
  total_bytes?: number;
  percentage: number;
}

export class WhisperManager {
  cachedFFmpegPath: string | null = null;
  currentDownloadProcess: WhisperDownloadProcess | null = null;
  ffmpegAvailabilityCache: {
    result: { available: boolean; path: string | null; error?: string } | null;
    expiresAt: number;
  } = { result: null, expiresAt: 0 };
  isInitialized = false;
  // Server manager for HTTP-based transcription
  serverManager = new WhisperServerManager();
  currentServerModel: string | null = null;
  cachedVadModelPath: string | null | undefined = undefined;
  private _transcribing = false;
  private _rewarmInFlight = false;

  getModelsDir(): string {
    return getModelsDirForService("whisper");
  }

  validateModelName(modelName: string): boolean {
    // Only allow known model names to prevent path traversal attacks
    const validModels = getValidModelNames();
    if (!validModels.includes(modelName)) {
      throw new Error(`Invalid model name: ${modelName}. Valid models: ${validModels.join(", ")}`);
    }
    return true;
  }

  getModelPath(modelName: string): string {
    this.validateModelName(modelName);
    const config = getWhisperModelConfig(modelName) as WhisperModelConfig;
    return path.join(this.getModelsDir(), config.fileName);
  }

  isModelDownloaded(modelName: string): boolean {
    return fs.existsSync(this.getModelPath(modelName));
  }

  getVadModelPath(): string | null {
    if (this.cachedVadModelPath !== undefined) return this.cachedVadModelPath;

    const fileName = "ggml-silero-v5.1.2.bin";
    const candidates: string[] = [];

    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "bin", "whisper-vad", fileName));
    }
    candidates.push(path.join(app.getAppPath(), "resources", "bin", "whisper-vad", fileName));

    const resolved = candidates.find((p) => fs.existsSync(p)) || null;
    this.cachedVadModelPath = resolved;
    return resolved;
  }

  async initializeAtStartup(settings: Record<string, unknown> = {}): Promise<void> {
    const startTime = Date.now();

    try {
      this.isInitialized = true;

      await cleanupStaleDownloads(this.getModelsDir());

      // Pre-warm whisper-server if local mode enabled (eliminates 2-5s cold-start delay)
      const localTranscriptionProvider = settings.localTranscriptionProvider as string | undefined;
      const whisperModel = settings.whisperModel as string | undefined;

      if (
        localTranscriptionProvider === "whisper" &&
        whisperModel &&
        this.serverManager.isAvailable()
      ) {
        const modelPath = this.getModelPath(whisperModel);

        if (fs.existsSync(modelPath)) {
          debugLogger.info("Pre-warming whisper-server", {
            model: whisperModel,
            modelPath,
          });

          try {
            const serverStartTime = Date.now();
            await this.serverManager.start(modelPath);
            this.currentServerModel = whisperModel;

            debugLogger.info("whisper-server pre-warmed successfully", {
              model: whisperModel,
              startupTimeMs: Date.now() - serverStartTime,
              port: this.serverManager.port,
            });
          } catch (err) {
            debugLogger.warn("Server pre-warm failed (will start on first use)", {
              error: (err as Error).message,
              model: whisperModel,
            });
            // Non-fatal: server will start on first transcription
          }
        } else {
          debugLogger.debug("Skipping server pre-warm: model not downloaded", {
            model: whisperModel,
            modelPath,
          });
        }
      } else {
        debugLogger.debug("Skipping server pre-warm", {
          reason:
            localTranscriptionProvider !== "whisper"
              ? "provider not whisper"
              : !whisperModel
                ? "no model selected"
                : "server binary not available",
        });
      }
    } catch (error) {
      debugLogger.warn("Whisper initialization error", {
        error: (error as Error).message,
      });
      this.isInitialized = true; // Mark initialized even on error
    }

    debugLogger.info("Whisper initialization complete", {
      totalTimeMs: Date.now() - startTime,
      serverRunning: this.serverManager.ready,
    });

    // Log dependency status for debugging
    await this.logDependencyStatus();
  }

  async logDependencyStatus(): Promise<void> {
    const status: {
      whisperServer: { available: boolean; path: string | null };
      ffmpeg: { available: boolean; path: string | null };
      models: Array<{ name: string; size: string }>;
    } = {
      whisperServer: {
        available: this.serverManager.isAvailable(),
        path: this.serverManager.getServerBinaryPath(),
      },
      ffmpeg: {
        available: false,
        path: null,
      },
      models: [],
    };

    // Check FFmpeg
    try {
      const ffmpegPath = await this.getFFmpegPath();
      status.ffmpeg.available = !!ffmpegPath;
      status.ffmpeg.path = ffmpegPath;
    } catch {
      // FFmpeg not available
    }

    // Check downloaded models
    for (const modelName of getValidModelNames()) {
      const modelPath = this.getModelPath(modelName);
      if (fs.existsSync(modelPath)) {
        try {
          const stats = fs.statSync(modelPath);
          status.models.push({
            name: modelName,
            size: `${Math.round(stats.size / (1024 * 1024))}MB`,
          });
        } catch {
          // Skip if can't stat
        }
      }
    }

    debugLogger.info("OpenHercules dependency check", status);

    // Log a summary for easy scanning
    const serverStatus = status.whisperServer.available
      ? `✓ ${status.whisperServer.path}`
      : "✗ Not found";
    const ffmpegStatus = status.ffmpeg.available ? `✓ ${status.ffmpeg.path}` : "✗ Not found";
    const modelsStatus =
      status.models.length > 0
        ? status.models.map((m) => `${m.name} (${m.size})`).join(", ")
        : "None downloaded";

    debugLogger.info(`[Dependencies] whisper-server: ${serverStatus}`);
    debugLogger.info(`[Dependencies] FFmpeg: ${ffmpegStatus}`);
    debugLogger.info(`[Dependencies] Models: ${modelsStatus}`);
  }

  async startServer(modelName: string, options: Record<string, unknown> = {}): Promise<{ success: boolean; reason?: string; port?: number }> {
    if (!this.serverManager.isAvailable()) {
      return { success: false, reason: "whisper-server binary not found" };
    }

    const modelPath = this.getModelPath(modelName);
    if (!fs.existsSync(modelPath)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    try {
      await this.serverManager.start(modelPath, options);
      this.currentServerModel = modelName;
      debugLogger.info("whisper-server started", {
        model: modelName,
        port: this.serverManager.port,
      });
      return { success: true, port: this.serverManager.port };
    } catch (error) {
      debugLogger.error("Failed to start whisper-server", { error: (error as Error).message });
      return { success: false, reason: (error as Error).message };
    }
  }

  async stopServer(): Promise<void> {
    await this.serverManager.stop();
    this.currentServerModel = null;
  }

  async onWakeFromSleep(): Promise<boolean> {
    const sm = this.serverManager;
    const modelName = this.currentServerModel;
    if (
      !shouldRewarmOnWake({
        isRemote: sm.isRemote,
        modelName,
        transcribing: this._transcribing,
        rewarmInFlight: this._rewarmInFlight,
      })
    ) {
      return false;
    }

    // Replay the last start options (VAD, threads) so the reloaded server
    // matches the signature the next dictation will use.
    const options = { ...sm.lastStartOptions };
    this._rewarmInFlight = true;
    try {
      debugLogger.info("Re-warming whisper-server after wake from sleep", { model: modelName });
      await this.stopServer();
      const result = await this.startServer(modelName as string, options);
      if (!result?.success) {
        debugLogger.warn("whisper-server wake re-warm failed", { reason: result?.reason });
        return false;
      }
      return true;
    } finally {
      this._rewarmInFlight = false;
    }
  }

  getServerStatus(): ReturnType<WhisperServerManager["getStatus"]> {
    return this.serverManager.getStatus();
  }

  async checkWhisperInstallation(): Promise<{ installed: boolean; working: boolean; path?: string }> {
    const serverPath = this.serverManager.getServerBinaryPath();
    if (!serverPath) {
      return { installed: false, working: false };
    }

    return {
      installed: true,
      working: this.serverManager.isAvailable(),
      path: serverPath,
    };
  }

  async transcribeLocalWhisper(audioBlob: AudioInput, options: Record<string, unknown> = {}): Promise<unknown> {
    debugLogger.logWhisperPipeline("transcribeLocalWhisper - start", {
      options,
      audioBlobType: audioBlob?.constructor?.name,
      audioBlobSize:
        (audioBlob as { byteLength?: number })?.byteLength ||
        (audioBlob as { size?: number })?.size ||
        0,
      serverAvailable: this.serverManager.isAvailable(),
      serverReady: this.serverManager.ready,
    });

    // Server mode required
    if (!this.serverManager.isAvailable()) {
      throw new Error(
        "whisper-server binary not found. Please ensure the app is installed correctly."
      );
    }

    const model = (options.model as string) || "base";
    const language = (options.language as string | undefined) || null;
    const initialPrompt = (options.initialPrompt as string | undefined) || null;
    const vadEnabled = options.vadEnabled === true;
    const vadConfig = options.vadConfig || null;
    const modelPath = this.getModelPath(model);

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Whisper model "${model}" not downloaded. Please download it from Settings.`);
    }

    return await this.transcribeViaServer(audioBlob, model, language, initialPrompt, {
      vadEnabled,
      vadConfig,
      signal: options.signal as AbortSignal | undefined,
      skipDecoderThresholds: options.skipDecoderThresholds === true,
    });
  }

  async transcribeViaServer(
    audioBlob: AudioInput,
    model: string,
    language: string | null,
    initialPrompt: string | null = null,
    options: { signal?: AbortSignal; vadEnabled?: boolean; vadConfig?: unknown; skipDecoderThresholds?: boolean } = {}
  ): Promise<unknown> {
    // Mark the server busy so a wake re-warm doesn't kill an in-flight dictation. See #766.
    this._transcribing = true;
    try {
      return await this._runServerTranscription(audioBlob, model, language, initialPrompt, options);
    } finally {
      this._transcribing = false;
    }
  }

  async _runServerTranscription(
    audioBlob: AudioInput,
    model: string,
    language: string | null,
    initialPrompt: string | null = null,
    options: { signal?: AbortSignal; vadEnabled?: boolean; vadConfig?: unknown; skipDecoderThresholds?: boolean } = {}
  ): Promise<unknown> {
    // An already-cancelled upload skips the server boot entirely.
    if (options.signal?.aborted) {
      throw createAbortError("whisper-server transcription cancelled");
    }

    debugLogger.info("Transcription mode: SERVER", { model, language: language || "auto" });
    const modelPath = this.getModelPath(model);

    const vadEnabled = options.vadEnabled === true;
    let vadModelPath = vadEnabled ? this.getVadModelPath() : null;
    if (vadEnabled && !vadModelPath) {
      // Issue #89: the VAD model is no longer bundled; fetch it on first use.
      vadModelPath = await ensureWhisperVadModel().catch((error: Error) => {
        debugLogger.warn("VAD model download failed", { error: error.message }, "assets");
        return null;
      });
    }
    if (vadEnabled && !vadModelPath) {
      debugLogger.warn("VAD requested but ggml-silero model not found; running without VAD");
    }

    await this.serverManager.start(modelPath, {
      vadEnabled,
      vadModelPath,
      vadConfig: options.vadConfig || null,
    });
    this.currentServerModel = model;

    // Convert audioBlob to Buffer if needed
    let audioBuffer;
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

    debugLogger.logWhisperPipeline("transcribeViaServer - sending to server", {
      bufferSize: audioBuffer.length,
      model,
      language,
      port: this.serverManager.port,
    });

    const startTime = Date.now();
    const result = await this.serverManager.transcribe(audioBuffer, {
      language,
      initialPrompt,
      signal: options.signal,
      skipDecoderThresholds: options.skipDecoderThresholds,
    });
    const elapsed = Date.now() - startTime;

    debugLogger.logWhisperPipeline("transcribeViaServer - completed", {
      elapsed,
      resultKeys: Object.keys(result),
    });

    return this.parseWhisperResult(result);
  }

  async transcribeViaLan(
    audioBlob: AudioInput,
    url: string,
    options: { language?: string | null; initialPrompt?: string | null } = {}
  ): Promise<unknown> {
    debugLogger.info("Transcription mode: LAN", { url, language: options.language || "auto" });

    await this.serverManager.connectRemote(url);

    let audioBuffer;
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

    debugLogger.logWhisperPipeline("transcribeViaLan - sending to server", {
      bufferSize: audioBuffer.length,
      url,
      language: options.language,
    });

    const startTime = Date.now();
    const result = await this.serverManager.transcribe(audioBuffer, {
      language: options.language || null,
      initialPrompt: options.initialPrompt || null,
    });
    const elapsed = Date.now() - startTime;

    debugLogger.logWhisperPipeline("transcribeViaLan - completed", {
      elapsed,
      resultKeys: Object.keys(result),
    });

    return this.parseWhisperResult(result);
  }

  // Normalize whitespace: replace newlines with spaces and collapse multiple spaces
  // whisper.cpp returns text with \n between audio segments which causes formatting issues
  normalizeWhitespace(text: string): string {
    return text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  }

  parseWhisperResult(output: unknown): { success: boolean; text?: string; message?: string; error?: string } {
    // Handle both string (from CLI) and object (from server) inputs
    let result: Record<string, unknown>;
    if (typeof output === "string") {
      debugLogger.logWhisperPipeline("Parsing result (string)", { length: output.length });
      try {
        result = JSON.parse(output);
      } catch (parseError) {
        // Try parsing as plain text (non-JSON output)
        const text = this.normalizeWhitespace(output);
        if (text && !this.isBlankAudioMarker(text)) {
          return { success: true, text };
        }
        throw new Error(`Failed to parse Whisper output: ${(parseError as Error).message}`);
      }
    } else if (typeof output === "object" && output !== null) {
      debugLogger.logWhisperPipeline("Parsing result (object)", {
        keys: Object.keys(output as Record<string, unknown>),
      });
      result = output as Record<string, unknown>;
    } else {
      throw new Error(`Unexpected Whisper output type: ${typeof output}`);
    }

    // Handle whisper.cpp JSON format (CLI mode)
    if (result.transcription && Array.isArray(result.transcription)) {
      const text = this.normalizeWhitespace(result.transcription.map((seg) => seg.text).join(""));
      if (!text || this.isBlankAudioMarker(text)) {
        return { success: false, message: "No audio detected" };
      }
      return { success: true, text };
    }

    // Handle whisper-server format (has "text" field directly)
    if (result.text !== undefined) {
      const text = typeof result.text === "string" ? this.normalizeWhitespace(result.text) : "";
      if (!text || this.isBlankAudioMarker(text)) {
        return { success: false, message: "No audio detected" };
      }
      return { success: true, text };
    }

    // A response with neither shape is a broken backend, not silence. Reporting it
    // as "No audio detected" sends users chasing their microphone when the engine
    // is at fault, so surface it as the transcription failure it is.
    const serverError = typeof result.error === "string" && result.error.trim();
    return {
      success: false,
      error: "invalid_response",
      message: serverError
        ? `Transcription engine error: ${serverError}`
        : "Transcription engine returned an unexpected response",
    };
  }

  // Check if text is a whisper.cpp blank audio marker
  isBlankAudioMarker(text: string): boolean {
    // whisper.cpp outputs "[BLANK_AUDIO]" when there's silence or insufficient audio
    const normalized = text.trim().toLowerCase();
    return normalized === "[blank_audio]" || normalized === "[ blank_audio ]";
  }

  async downloadWhisperModel(
    modelName: string,
    progressCallback: ((event: DownloadProgressEvent) => void) | null = null
  ): Promise<Record<string, unknown>> {
    this.validateModelName(modelName);
    const modelConfig = getWhisperModelConfig(modelName) as WhisperModelConfig;

    const modelPath = this.getModelPath(modelName);
    const modelsDir = this.getModelsDir();

    if (fs.existsSync(modelPath)) {
      const stats = await fsPromises.stat(modelPath);
      return {
        model: modelName,
        downloaded: true,
        path: modelPath,
        size_bytes: stats.size,
        size_mb: Math.round(stats.size / (1024 * 1024)),
        success: true,
      };
    }

    if (this.currentDownloadProcess) {
      throw createDownloadInProgressError(modelName, this.currentDownloadProcess.model);
    }

    const { signal, abort } = createDownloadSignal();
    const downloadProcess: WhisperDownloadProcess = {
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

      const spaceCheck = await checkDiskSpace(modelsDir, modelConfig.size * 1.2);
      if (!spaceCheck.ok) {
        throw new Error(
          `Not enough disk space to download model. Need ~${Math.round((modelConfig.size * 1.2) / 1_000_000)}MB, ` +
            `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
      }

      await downloadFile(modelConfig.url, modelPath, {
        timeout: 600000,
        signal,
        expectedSize: modelConfig.size,
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

      await validateFileSize(modelPath, modelConfig.size);

      const stats = await fsPromises.stat(modelPath);

      if (progressCallback) {
        progressCallback({ type: "complete", model: modelName, percentage: 100 });
      }

      return {
        model: modelName,
        downloaded: true,
        path: modelPath,
        size_bytes: stats.size,
        size_mb: Math.round(stats.size / (1024 * 1024)),
        success: true,
      };
    } catch (error) {
      if ((error as { isAbort?: boolean }).isAbort) {
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

  async cancelDownload(): Promise<{ success: boolean; message?: string; error?: string }> {
    if (this.currentDownloadProcess) {
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
      isInstalling: false,
      downloadProgress: activeDownload ? (this.currentDownloadProcess as WhisperDownloadProcess).percentage : 0,
      downloadedBytes: activeDownload ? (this.currentDownloadProcess as WhisperDownloadProcess).downloadedBytes : 0,
      totalBytes: activeDownload ? (this.currentDownloadProcess as WhisperDownloadProcess).totalBytes : 0,
    };

    if (fs.existsSync(modelPath)) {
      const stats = await fsPromises.stat(modelPath);
      return {
        model: modelName,
        downloaded: true,
        path: modelPath,
        size_bytes: stats.size,
        size_mb: Math.round(stats.size / (1024 * 1024)),
        success: true,
        ...downloadStatus,
      };
    }

    return { model: modelName, downloaded: false, success: true, ...downloadStatus };
  }

  async listWhisperModels(): Promise<{ models: unknown[]; cache_dir: string; success: boolean }> {
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

  async deleteWhisperModel(modelName: string): Promise<Record<string, unknown>> {
    const modelPath = this.getModelPath(modelName);

    if (fs.existsSync(modelPath)) {
      const stats = await fsPromises.stat(modelPath);
      await fsPromises.unlink(modelPath);
      return {
        model: modelName,
        deleted: true,
        freed_bytes: stats.size,
        freed_mb: Math.round(stats.size / (1024 * 1024)),
        success: true,
      };
    }

    return { model: modelName, deleted: false, error: "Model not found", success: false };
  }

  async deleteAllWhisperModels(): Promise<Record<string, unknown>> {
    const modelsDir = this.getModelsDir();
    let totalFreed = 0;
    let deletedCount = 0;

    try {
      if (!fs.existsSync(modelsDir)) {
        return { success: true, deleted_count: 0, freed_bytes: 0, freed_mb: 0 };
      }

      const files = await fsPromises.readdir(modelsDir);
      for (const file of files) {
        if (file.endsWith(".bin")) {
          const filePath = path.join(modelsDir, file);
          try {
            const stats = await fsPromises.stat(filePath);
            await fsPromises.unlink(filePath);
            totalFreed += stats.size;
            deletedCount++;
          } catch {
            // Continue with other files if one fails
          }
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

  // FFmpeg methods (still needed for audio format conversion)
  async getFFmpegPath(): Promise<string | null> {
    if (this.cachedFFmpegPath) {
      return this.cachedFFmpegPath;
    }

    let ffmpegPath;

    try {
      ffmpegPath = require("ffmpeg-static") as string;
      ffmpegPath = path.normalize(ffmpegPath);

      if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
        ffmpegPath += ".exe";
      }

      debugLogger.debug("FFmpeg static path from module", { ffmpegPath });

      // Try unpacked ASAR path first (production builds unpack ffmpeg-static)
      // Handle both forward slashes and backslashes for cross-platform compatibility
      const unpackedPath = ffmpegPath.includes("app.asar")
        ? ffmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
        : null;

      if (unpackedPath) {
        debugLogger.debug("Checking unpacked ASAR path", { unpackedPath });
        if (fs.existsSync(unpackedPath)) {
          if (process.platform !== "win32") {
            try {
              fs.accessSync(unpackedPath, fs.constants.X_OK);
            } catch {
              debugLogger.debug("FFmpeg not executable, attempting chmod", { unpackedPath });
              try {
                fs.chmodSync(unpackedPath, 0o755);
              } catch (chmodErr) {
                debugLogger.warn("Failed to chmod FFmpeg", { error: (chmodErr as Error).message });
              }
            }
          }
          debugLogger.debug("Found FFmpeg in unpacked ASAR", { path: unpackedPath });
          this.cachedFFmpegPath = unpackedPath;
          return unpackedPath;
        } else {
          debugLogger.warn("Unpacked ASAR path does not exist", { unpackedPath });
        }
      }

      // Try original path (development or if not in ASAR)
      if (fs.existsSync(ffmpegPath)) {
        if (process.platform !== "win32") {
          fs.accessSync(ffmpegPath, fs.constants.X_OK);
        }
        debugLogger.debug("Found FFmpeg at bundled path", { path: ffmpegPath });
        this.cachedFFmpegPath = ffmpegPath;
        return ffmpegPath;
      } else {
        debugLogger.warn("Bundled FFmpeg path does not exist", { ffmpegPath });
      }
    } catch (err) {
      debugLogger.warn("Bundled FFmpeg not available", { error: (err as Error).message });
    }

    // Try system FFmpeg paths
    const systemCandidates =
      process.platform === "darwin"
        ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
        : process.platform === "win32"
          ? ["C:\\ffmpeg\\bin\\ffmpeg.exe"]
          : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

    debugLogger.debug("Trying system FFmpeg candidates", { candidates: systemCandidates });

    for (const candidate of systemCandidates) {
      if (fs.existsSync(candidate)) {
        debugLogger.debug("Found system FFmpeg", { path: candidate });
        this.cachedFFmpegPath = candidate;
        return candidate;
      }
    }

    debugLogger.error("FFmpeg not found anywhere");
    return null;
  }

  async checkFFmpegAvailability(): Promise<{ available: boolean; path: string | null; error?: string }> {
    const now = Date.now();
    if (
      this.ffmpegAvailabilityCache.result !== null &&
      now < this.ffmpegAvailabilityCache.expiresAt
    ) {
      return this.ffmpegAvailabilityCache.result;
    }

    const ffmpegPath = await this.getFFmpegPath();
    const result: { available: boolean; path: string | null; error?: string } = ffmpegPath
      ? { available: true, path: ffmpegPath }
      : { available: false, path: null, error: "FFmpeg not found" };

    this.ffmpegAvailabilityCache = { result, expiresAt: now + CACHE_TTL_MS };
    return result;
  }

  async getDiagnostics(): Promise<Record<string, unknown>> {
    const diagnostics: {
      platform: NodeJS.Platform;
      arch: string;
      resourcesPath: string | null;
      isPackaged: boolean;
      ffmpeg: { available: boolean; path: string | null; error: string | null };
      whisperServer: { available: boolean; path: string | null };
      modelsDir: string;
      models: string[];
    } & Record<string, unknown> = {
      platform: process.platform,
      arch: process.arch,
      resourcesPath: process.resourcesPath || null,
      isPackaged: !!process.resourcesPath && !process.resourcesPath.includes("node_modules"),
      ffmpeg: { available: false, path: null, error: null },
      whisperServer: { available: false, path: null },
      modelsDir: this.getModelsDir(),
      models: [],
    };

    // Check FFmpeg
    try {
      this.cachedFFmpegPath = null; // Clear cache for fresh check
      const ffmpegPath = await this.getFFmpegPath();
      if (ffmpegPath) {
        diagnostics.ffmpeg = { available: true, path: ffmpegPath, error: null };
      } else {
        diagnostics.ffmpeg = { available: false, path: null, error: "Not found" };
      }
    } catch (err) {
      diagnostics.ffmpeg = { available: false, path: null, error: (err as Error).message };
    }

    // Check whisper server
    if (this.serverManager) {
      const serverPath = this.serverManager.getServerBinaryPath?.();
      diagnostics.whisperServer = {
        available: this.serverManager.isAvailable(),
        path: serverPath || null,
      };
    }

    // Check downloaded models
    try {
      const modelsDir = this.getModelsDir();
      if (fs.existsSync(modelsDir)) {
        const files = fs.readdirSync(modelsDir);
        diagnostics.models = files
          .filter((f: string) => f.startsWith("ggml-") && f.endsWith(".bin"))
          .map((f: string) => f.replace("ggml-", "").replace(".bin", ""));
      }
    } catch {
      // Ignore errors reading models dir
    }

    return diagnostics;
  }
}



// Dual export: main.js and legacy tests require this module as the class
// itself, while the TS graph imports the named export.
module.exports = WhisperManager;
module.exports.WhisperManager = WhisperManager;
module.exports.shouldRewarmOnWake = shouldRewarmOnWake;
