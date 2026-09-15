// Shared wire contract for the local Whisper/Parakeet model lifecycle:
// install checks, downloads (with progress events), model status/list/delete,
// server lifecycle, VAD config and diagnostics. Renderer shapes mirror the
// manager results exactly — no second projection.
import { z } from "zod";

export const localModelChannels = {
  checkWhisperInstallation: "check-whisper-installation",
  downloadWhisperModel: "download-whisper-model",
  whisperDownloadProgress: "whisper-download-progress",
  checkModelStatus: "check-model-status",
  listWhisperModels: "list-whisper-models",
  deleteWhisperModel: "delete-whisper-model",
  deleteAllWhisperModels: "delete-all-whisper-models",
  cancelWhisperDownload: "cancel-whisper-download",
  whisperServerStart: "whisper-server-start",
  whisperServerStop: "whisper-server-stop",
  whisperServerStatus: "whisper-server-status",
  checkFfmpegAvailability: "check-ffmpeg-availability",
  getAudioDiagnostics: "get-audio-diagnostics",
  whisperVadGetConfig: "whisper-vad-get-config",
  whisperVadSetConfig: "whisper-vad-set-config",
  checkParakeetInstallation: "check-parakeet-installation",
  downloadParakeetModel: "download-parakeet-model",
  parakeetDownloadProgress: "parakeet-download-progress",
  checkParakeetModelStatus: "check-parakeet-model-status",
  listParakeetModels: "list-parakeet-models",
  deleteParakeetModel: "delete-parakeet-model",
  deleteAllParakeetModels: "delete-all-parakeet-models",
  cancelParakeetDownload: "cancel-parakeet-download",
  getParakeetDiagnostics: "get-parakeet-diagnostics",
  parakeetServerStart: "parakeet-server-start",
  parakeetServerStop: "parakeet-server-stop",
  parakeetServerStatus: "parakeet-server-status",
} as const;

const modelNameSchema = z.string().min(1);

export const downloadProgressEventSchema = z.object({
  type: z.enum(["progress", "installing", "complete", "error"]),
  model: z.string(),
  downloaded_bytes: z.number().optional(),
  total_bytes: z.number().optional(),
  percentage: z.number().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  sequence: z.number().optional(),
});
export type DownloadProgressEvent = z.infer<typeof downloadProgressEventSchema>;

export const whisperVadConfigSchema = z.record(z.string(), z.unknown());
export type WhisperVadConfigWire = z.infer<typeof whisperVadConfigSchema>;

// Manager result shapes as they cross the wire. The index signature keeps the
// renderer's non-strict consumers working while pinning the fields every
// consumer reads.
export interface LocalModelStatusRow {
  model: string;
  downloaded: boolean;
  success?: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  [key: string]: unknown;
}

export interface LocalModelListResult {
  success: boolean;
  models: LocalModelStatusRow[];
  cache_dir: string;
  [key: string]: unknown;
}

export interface LocalModelActionResult {
  success: boolean;
  error?: string;
  code?: string;
  message?: string;
  model?: string;
  deleted?: boolean;
  deleted_count?: number;
  freed_bytes?: number;
  freed_mb?: number;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  [key: string]: unknown;
}

export interface InstallCheckResult {
  installed: boolean;
  working: boolean;
  supported?: boolean;
  code?: string;
  message?: string;
  path?: string;
  [key: string]: unknown;
}

export interface ServerLifecycleResult {
  success: boolean;
  reason?: string;
  error?: string;
  port?: number;
  code?: string;
  [key: string]: unknown;
}

export interface ServerStatusResult {
  available: boolean;
  running: boolean;
  starting?: boolean;
  port?: number | null;
  hostname?: string;
  isRemote?: boolean;
  modelPath?: string | null;
  modelName?: string | null;
  [key: string]: unknown;
}

export interface FfmpegAvailabilityResult {
  available: boolean;
  path?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

export interface VadConfigResult {
  success: boolean;
  config?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

export interface DiagnosticsResult {
  platform?: string;
  arch?: string;
  modelsDir?: string;
  models?: unknown[];
  ffmpeg?: Record<string, unknown>;
  whisperServer?: Record<string, unknown>;
  sherpaOnnx?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LocalModelLifecycleApi {
  checkWhisperInstallation(): Promise<InstallCheckResult>;
  downloadWhisperModel(modelName: string): Promise<LocalModelActionResult>;
  onWhisperDownloadProgress(callback: (data: DownloadProgressEvent) => void): () => void;
  checkModelStatus(modelName: string): Promise<LocalModelStatusRow>;
  listWhisperModels(): Promise<LocalModelListResult>;
  deleteWhisperModel(modelName: string): Promise<LocalModelActionResult>;
  deleteAllWhisperModels(): Promise<LocalModelActionResult>;
  cancelWhisperDownload(): Promise<ServerLifecycleResult>;
  whisperServerStart(modelName: string): Promise<ServerLifecycleResult>;
  whisperServerStop(): Promise<void>;
  whisperServerStatus(): Promise<ServerStatusResult>;
  checkFfmpegAvailability(): Promise<FfmpegAvailabilityResult>;
  getAudioDiagnostics(): Promise<DiagnosticsResult>;
  getWhisperVadConfig(): Promise<VadConfigResult>;
  setWhisperVadConfig(config: Record<string, unknown>): Promise<VadConfigResult>;
  checkParakeetInstallation(): Promise<InstallCheckResult>;
  downloadParakeetModel(modelName: string): Promise<LocalModelActionResult>;
  onParakeetDownloadProgress(callback: (data: DownloadProgressEvent) => void): () => void;
  checkParakeetModelStatus(modelName: string): Promise<LocalModelStatusRow>;
  listParakeetModels(): Promise<LocalModelListResult>;
  deleteParakeetModel(modelName: string): Promise<LocalModelActionResult>;
  deleteAllParakeetModels(): Promise<LocalModelActionResult>;
  cancelParakeetDownload(): Promise<ServerLifecycleResult>;
  getParakeetDiagnostics(): Promise<DiagnosticsResult>;
  parakeetServerStart(modelName: string): Promise<ServerLifecycleResult>;
  parakeetServerStop(): Promise<unknown>;
  parakeetServerStatus(): Promise<ServerStatusResult>;
}

export { modelNameSchema };
