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

// The VAD wire config: the settings owner sanitizes to these numeric keys and
// both get/set return the sanitized merged view.
export const whisperVadConfigSchema = z.object({
  threshold: z.number(),
  minSpeechDurationMs: z.number(),
  minSilenceDurationMs: z.number(),
  maxSpeechDurationS: z.number(),
  speechPadMs: z.number(),
  samplesOverlap: z.number(),
});

export type WhisperVadConfig = z.infer<typeof whisperVadConfigSchema>;

export const whisperVadWireConfigSchema = whisperVadConfigSchema.extend({
  noteRecordingSileroEnabled: z.boolean(),
  meetingSileroEnabled: z.boolean(),
});

export type WhisperVadWireConfig = z.infer<typeof whisperVadWireConfigSchema>;

export const whisperVadResultSchema = z.object({
  success: z.boolean(),
  config: whisperVadWireConfigSchema.optional(),
  error: z.string().optional(),
});

export type WhisperVadResult = z.infer<typeof whisperVadResultSchema>;

// The renderer sends sanitized numeric fields plus the Silero toggles; the
// settings owner filters unknown keys before the write. The partial schema is
// the wire parse for an update payload.
export type WhisperVadConfigUpdate = Partial<WhisperVadWireConfig>;

export const whisperVadConfigUpdateSchema = whisperVadWireConfigSchema.partial();

// Loose native/manager rows as they cross the wire. The renderer only reads
// the fields below; managers return plain objects with exactly these names
// (whisper.ts / parakeet.ts / modelManagerBridge.ts).
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
  error?: string;
  code?: string;
}

export interface LocalModelListResult {
  success: boolean;
  models: LocalModelStatusRow[];
  cache_dir: string;
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
}

export interface InstallCheckResult {
  installed: boolean;
  working: boolean;
  supported?: boolean;
  code?: string;
  message?: string;
  path?: string;
}

export interface ServerLifecycleResult {
  success: boolean;
  reason?: string;
  error?: string;
  port?: number;
  code?: string;
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
}

export interface FfmpegAvailabilityResult {
  available: boolean;
  path?: string | null;
  error?: string | null;
}

export interface DiagnosticsResult {
  platform?: string;
  arch?: string;
  modelsDir?: string;
  models?: string[];
  ffmpeg?: {
    available: boolean;
    path: string | null;
    error: string | null;
  };
  whisperServer?: {
    available: boolean;
    path: string | null;
  };
  sherpaOnnx?: {
    available: boolean;
    path: string | null;
  };
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
  getWhisperVadConfig(): Promise<WhisperVadResult>;
  setWhisperVadConfig(config: WhisperVadConfigUpdate): Promise<WhisperVadResult>;
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
  parakeetServerStop(): Promise<void>;
  parakeetServerStatus(): Promise<ServerStatusResult>;
}

export { modelNameSchema };
