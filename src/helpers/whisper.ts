import { app } from "electron";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { z } from "zod";
import debugLogger from "./debugLogger.js";
import { ensureWhisperVadModel } from "./whisperVadModel.js";
import {
  downloadFile,
  createDownloadSignal,
  createDownloadInProgressError,
  validateFileSize,
  cleanupStaleDownloads,
  checkDiskSpace,
  type DownloadError,
} from "./downloadUtils.js";
import { WhisperServerManager, type WhisperServerStartOptions } from "./whisperServer.js";
import { createAbortError } from "./abortError.js";
import { getModelsDirForService } from "./modelDirUtils.js";
import modelRegistryData from "../models/modelRegistryData.json";
import type {
  DiagnosticsResult,
  FfmpegAvailabilityResult,
  InstallCheckResult,
  LocalModelActionResult,
  LocalModelListResult,
  LocalModelStatusRow,
  ServerLifecycleResult,
} from "../contracts/localModelLifecycle.js";
import type { TranscriptionResponse } from "../contracts/localFileTranscription.js";

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

function getWhisperModelConfig(modelName: string): WhisperModelConfig {
  // SAFETY: modelRegistryData.json is this repo's own packaged catalog; the
  // assertion pins its per-model entry shape declared above. Callers validate
  // the name first, so a missing entry is a programming error.
  const registry = modelRegistryData.whisperModels as Record<string, WhisperModelRegistryEntry>;
  const modelInfo = registry[modelName];

  if (!modelInfo) {
    throw new Error(`Unknown whisper model: ${modelName}`);
  }

  return {
    url: modelInfo.downloadUrl,
    size: modelInfo.expectedSizeBytes || (modelInfo.sizeMb ?? 0) * 1_000_000,
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

// The settings slice this manager reads at startup; the caller (main.ts)
// builds it from environment variables.
export interface WhisperStartupSettings {
  localTranscriptionProvider?: string;
  whisperModel?: string;
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

// The optional bag transcribeLocalWhisper accepts. The typed IPC options
// (TranscriptionOptions) and the VAD resolver's numeric keys flow through the
// index signature; only the named fields below are read by the manager.
export interface WhisperLocalTranscribeOptions {
  model?: string;
  language?: string | null;
  initialPrompt?: string | null;
  vadEnabled?: boolean;
  vadConfig?: unknown;
  signal?: AbortSignal;
  skipDecoderThresholds?: boolean;
}

// The server-transcription options pair with the explicit language/prompt
// arguments, so they omit the fields the manager already receives.
export interface WhisperTranscribeOptions {
  vadEnabled?: boolean;
  vadConfig?: unknown;
  signal?: AbortSignal;
  skipDecoderThresholds?: boolean;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isStringAudio(input: AudioInput): input is string {
  return typeof input === "string";
}

function audioInputByteLength(input: AudioInput | null | undefined): number {
  if (input === null || input === undefined) return 0;

  if (isStringAudio(input)) return input.length;

  return input.byteLength;
}

// The several audio shapes the IPC bridge hands over; all collapse to the one
// Buffer the whisper-server request needs.
function toAudioBuffer(input: AudioInput): Buffer {
  if (Buffer.isBuffer(input)) return input;

  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }

  if (input instanceof ArrayBuffer) return Buffer.from(input);

  if (isStringAudio(input)) return Buffer.from(input, "base64");

  // The last shape carries a nested buffer; the 3-arg Buffer.from form needs an
  // ArrayBuffer, which is what the bridge always supplies here.
  // SAFETY: the IPC audio path sends { buffer: ArrayBuffer, ... }; the
  // ArrayBufferView arm of the type is not produced by that path.
  const nested = input.buffer as ArrayBuffer;

  return Buffer.from(nested, input.byteOffset || 0, input.byteLength);
}

function isDownloadAbort(error: unknown): error is DownloadError {
  return (
    typeof error === "object" && error !== null && "isAbort" in error && error.isAbort === true
  );
}

// The download result additionally reports whether the file is now on disk,
// which the renderer's model inventory reads.
interface WhisperDownloadResult extends LocalModelActionResult {
  downloaded?: boolean;
}

interface WhisperRawResult {
  text?: unknown;
  error?: unknown;
  transcription?: Array<{ text?: string }>;
}

// Whisper-server and whisper.cpp CLI emit either a text field or a
// transcription array; anything else is a backend failure. The schema mirrors
// the tolerant reader that predated it: unknown extra keys are ignored and a
// non-string text degrades to an empty string.
// The tolerant wire reader mirrors the previous record()-based parsing: text
// and error stay unknown until a string guard narrows them, and a junk
// transcription entry degrades to {}.
const whisperResultSchema = z.looseObject({
  text: z.unknown().optional(),
  error: z.unknown().optional(),
  transcription: z.array(z.looseObject({ text: z.string().optional() }).catch({})).optional(),
});

function isWhisperStdout(output: WhisperRawResult | string | null | undefined): output is string {
  return typeof output === "string";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

interface FfmpegAvailabilityCache {
  result: FfmpegAvailabilityResult | null;
  expiresAt: number;
}

interface DependencyStatus {
  whisperServer: { available: boolean; path: string | null };
  ffmpeg: { available: boolean; path: string | null };
  models: Array<{ name: string; size: string }>;
}

export class WhisperManager {
  cachedFFmpegPath: string | null = null;
  currentDownloadProcess: WhisperDownloadProcess | null = null;
  ffmpegAvailabilityCache: FfmpegAvailabilityCache = { result: null, expiresAt: 0 };
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
    const config = getWhisperModelConfig(modelName);

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

  async initializeAtStartup(settings: WhisperStartupSettings = {}): Promise<void> {
    const startTime = Date.now();

    try {
      this.isInitialized = true;

      await cleanupStaleDownloads(this.getModelsDir());

      // Pre-warm whisper-server if local mode enabled (eliminates 2-5s cold-start delay)
      const localTranscriptionProvider = settings.localTranscriptionProvider;
      const whisperModel = settings.whisperModel;

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
              error: err instanceof Error ? err.message : String(err),
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
        error: error instanceof Error ? error.message : String(error),
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
    const status: DependencyStatus = {
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

    debugLogger.info("Gristmill dependency check", status);

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

  async startServer(
    modelName: string,
    options: WhisperServerStartOptions = {}
  ): Promise<ServerLifecycleResult> {
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

      return { success: true, port: this.serverManager.port ?? undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLogger.error("Failed to start whisper-server", { error: message });

      return { success: false, reason: message };
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
      !modelName ||
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
      const result = await this.startServer(modelName, options);

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

  async checkWhisperInstallation(): Promise<InstallCheckResult> {
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

  async transcribeLocalWhisper(
    audioBlob: AudioInput,
    options: WhisperLocalTranscribeOptions = {}
  ): Promise<TranscriptionResponse> {
    debugLogger.logWhisperPipeline("transcribeLocalWhisper - start", {
      options,
      audioBlobType: audioBlob?.constructor?.name,
      audioBlobSize: audioInputByteLength(audioBlob),
      serverAvailable: this.serverManager.isAvailable(),
      serverReady: this.serverManager.ready,
    });

    const model = isString(options.model) ? options.model : "base";
    const language = isString(options.language) ? options.language : null;
    const initialPrompt = isString(options.initialPrompt) ? options.initialPrompt : null;
    const vadEnabled = options.vadEnabled === true;
    const vadConfig = options.vadConfig || null;
    const modelPath = this.getModelPath(model);

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Whisper model "${model}" not downloaded. Please download it from Settings.`);
    }

    return await this.transcribeViaServer(audioBlob, model, language, initialPrompt, {
      vadEnabled,
      vadConfig,
      signal: isAbortSignal(options.signal) ? options.signal : undefined,
      skipDecoderThresholds: options.skipDecoderThresholds === true,
    });
  }

  async transcribeViaServer(
    audioBlob: AudioInput,
    model: string,
    language: string | null,
    initialPrompt: string | null = null,
    options: WhisperTranscribeOptions = {}
  ): Promise<TranscriptionResponse> {
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
    options: WhisperTranscribeOptions = {}
  ): Promise<TranscriptionResponse> {
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

    const audioBuffer = toAudioBuffer(audioBlob);

    if (audioBuffer.length === 0) {
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
  ): Promise<TranscriptionResponse> {
    debugLogger.info("Transcription mode: LAN", { url, language: options.language || "auto" });

    await this.serverManager.connectRemote(url);

    const audioBuffer = toAudioBuffer(audioBlob);

    if (audioBuffer.length === 0) {
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

  // Both string (CLI stdout) and object (server reply) inputs cross this
  // parse boundary; a non-JSON string is retried as plain text exactly like
  // the previous reader, and a response with neither shape is reported as an
  // engine failure rather than silence. The schema below validates the object
  // case and ignores unknown keys.
  parseWhisperResult(output: WhisperRawResult | string | null | undefined): TranscriptionResponse {
    let raw: WhisperRawResult;

    if (isWhisperStdout(output)) {
      debugLogger.logWhisperPipeline("Parsing result (string)", { length: output.length });

      try {
        // SAFETY: JSON.parse returns an unknown value; whisperResultSchema.parse
        // below validates it against the tolerant reader before any field is read.
        raw = JSON.parse(output) as WhisperRawResult;
      } catch (parseError) {
        const text = this.normalizeWhitespace(output);

        if (text && !this.isBlankAudioMarker(text)) {
          return { success: true, text };
        }

        throw new Error(
          `Failed to parse Whisper output: ${parseError instanceof Error ? parseError.message : String(parseError)}`
        );
      }
    } else if (output === null || output === undefined) {
      throw new Error(`Unexpected Whisper output type: ${output === null ? "null" : "undefined"}`);
    } else {
      raw = output;
    }

    const result = whisperResultSchema.parse(raw);
    debugLogger.logWhisperPipeline("Parsing result (object)", { keys: Object.keys(result) });

    // Handle whisper.cpp JSON format (CLI mode)
    if (result.transcription && Array.isArray(result.transcription)) {
      const text = this.normalizeWhitespace(
        result.transcription.map((seg) => seg.text ?? "").join("")
      );

      if (!text || this.isBlankAudioMarker(text)) {
        return { success: false, message: "No audio detected" };
      }

      return { success: true, text };
    }

    // Handle whisper-server format (has "text" field directly)
    if (result.text !== undefined) {
      const text = isString(result.text) ? this.normalizeWhitespace(result.text) : "";

      if (!text || this.isBlankAudioMarker(text)) {
        return { success: false, message: "No audio detected" };
      }

      return { success: true, text };
    }

    // A response with neither shape is a broken backend, not silence. Reporting it
    // as "No audio detected" sends users chasing their microphone when the engine
    // is at fault, so surface it as the transcription failure it is.
    const serverError = isString(result.error) && result.error.trim();

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
  ): Promise<WhisperDownloadResult> {
    this.validateModelName(modelName);
    const modelConfig = getWhisperModelConfig(modelName);

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

    const downloadHandle = createDownloadSignal();
    const signal = downloadHandle.signal;

    const downloadProcess: WhisperDownloadProcess = {
      abort: () => downloadHandle.abort(),
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
      if (isDownloadAbort(error)) {
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

  async checkModelStatus(modelName: string): Promise<LocalModelStatusRow> {
    const modelPath = this.getModelPath(modelName);
    const download = this.currentDownloadProcess;
    const activeDownload = download?.model === modelName;

    const downloadStatus = {
      isDownloading: activeDownload,
      isInstalling: false,
      downloadProgress: activeDownload && download ? download.percentage : 0,
      downloadedBytes: activeDownload && download ? download.downloadedBytes : 0,
      totalBytes: activeDownload && download ? download.totalBytes : 0,
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

  async listWhisperModels(): Promise<LocalModelListResult> {
    const models = getValidModelNames();
    const modelInfo: LocalModelStatusRow[] = [];

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

  async deleteWhisperModel(modelName: string): Promise<LocalModelActionResult> {
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

  async deleteAllWhisperModels(): Promise<LocalModelActionResult> {
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
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // FFmpeg methods (still needed for audio format conversion)
  async getFFmpegPath(): Promise<string | null> {
    if (this.cachedFFmpegPath) {
      return this.cachedFFmpegPath;
    }

    let ffmpegPath;

    try {
      // SAFETY: ffmpeg-static exports the absolute binary path as a string;
      // the package ships no types, so the require result is declared here.
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
                debugLogger.warn("Failed to chmod FFmpeg", {
                  error: chmodErr instanceof Error ? chmodErr.message : String(chmodErr),
                });
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
      debugLogger.warn("Bundled FFmpeg not available", {
        error: err instanceof Error ? err.message : String(err),
      });
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

  async checkFFmpegAvailability(): Promise<FfmpegAvailabilityResult> {
    const now = Date.now();

    if (
      this.ffmpegAvailabilityCache.result !== null &&
      now < this.ffmpegAvailabilityCache.expiresAt
    ) {
      return this.ffmpegAvailabilityCache.result;
    }

    const ffmpegPath = await this.getFFmpegPath();

    const result: FfmpegAvailabilityResult = ffmpegPath
      ? { available: true, path: ffmpegPath }
      : { available: false, path: null, error: "FFmpeg not found" };

    this.ffmpegAvailabilityCache = { result, expiresAt: now + CACHE_TTL_MS };

    return result;
  }

  async getDiagnostics(): Promise<DiagnosticsResult> {
    // The manager reports a few extra environment fields alongside the wire
    // DiagnosticsResult the renderer reads.
    const diagnostics: DiagnosticsResult & {
      resourcesPath: string | null;
      isPackaged: boolean;
    } = {
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
      diagnostics.ffmpeg = {
        available: false,
        path: null,
        error: err instanceof Error ? err.message : String(err),
      };
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

Object.assign(module.exports, {
  WhisperManager,
  shouldRewarmOnWake,
});
