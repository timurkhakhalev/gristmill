// Shared wire contract for the local LLM (llama.cpp) model surface: catalog
// with download status, downloads (with progress events), deletion, runtime
// availability, the llama.cpp installer checks and llama-server lifecycle.
// Renderer shapes mirror the manager results exactly — no second projection.
import { z } from "zod";

export const localLlmChannels = {
  modelGetAll: "model-get-all",
  modelGetActiveDownloads: "model-get-active-downloads",
  modelCheck: "model-check",
  modelDownload: "model-download",
  modelDownloadProgress: "model-download-progress",
  modelDelete: "model-delete",
  modelDeleteAll: "model-delete-all",
  modelCancelDownload: "model-cancel-download",
  modelCheckRuntime: "model-check-runtime",
  llamaCppCheck: "llama-cpp-check",
  llamaCppInstall: "llama-cpp-install",
  llamaCppUninstall: "llama-cpp-uninstall",
  llamaServerStart: "llama-server-start",
  llamaServerStop: "llama-server-stop",
  llamaServerStatus: "llama-server-status",
} as const;

export const llmDownloadProgressEventSchema = z.object({
  type: z.enum(["progress", "complete", "error"]).optional(),
  modelId: z.string(),
  progress: z.number().optional(),
  downloadedSize: z.number().optional(),
  totalSize: z.number().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  details: z.unknown().optional(),
  sequence: z.number().optional(),
});

export type LlmDownloadProgressEvent = z.infer<typeof llmDownloadProgressEventSchema>;

// Catalog fields plus the main-process download snapshot.
export const localLlmModelStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string(),
  sizeBytes: z.number(),
  description: z.string(),
  descriptionKey: z.string().optional(),
  fileName: z.string(),
  quantization: z.string(),
  contextLength: z.number(),
  hfRepo: z.string(),
  recommended: z.boolean().optional(),
  supportsThinking: z.boolean().optional(),
  draftHfRepo: z.string().optional(),
  draftFileName: z.string().optional(),
  draftSizeBytes: z.number().optional(),
  providerId: z.string(),
  providerName: z.string(),
  isDownloaded: z.boolean(),
  isDownloading: z.boolean(),
  downloadProgress: z.number(),
  downloadedSize: z.number(),
  totalSize: z.number(),
  path: z.string().nullable(),
});

export type LocalLlmModelStatus = z.infer<typeof localLlmModelStatusSchema>;

// The tracker is shared by native speech models and LLMs.
export const localModelDownloadStatusRowSchema = z.object({
  modelType: z.enum(["whisper", "parakeet", "llm"]),
  modelId: z.string(),
  phase: z.enum(["downloading", "installing"]),
  progress: z.number(),
  downloadedBytes: z.number(),
  totalBytes: z.number(),
  sequence: z.number(),
});

export type LocalModelDownloadStatusRow = z.infer<typeof localModelDownloadStatusRowSchema>;

export interface LlmActionResult {
  success: boolean;
  error?: string;
  code?: string;
  details?: string;
}

export interface LlmDownloadResult extends LlmActionResult {
  path?: string;
}

export interface LlmRuntimeCheckResult {
  available: boolean;
  error?: string;
  code?: string;
  details?: string;
}

export interface LlamaCppCheckResult {
  isInstalled: boolean;
  version?: string | null;
  error?: string;
}

export interface LlamaServerStartResult {
  success: boolean;
  port?: number;
  error?: string;
}

export type LlamaBackend = "cpu" | "metal" | null;

export interface LlamaServerStatusRow {
  available: boolean;
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  backend: LlamaBackend;
}

export interface LocalLlmModelsApi {
  modelGetAll(): Promise<LocalLlmModelStatus[]>;
  modelGetActiveDownloads(): Promise<LocalModelDownloadStatusRow[]>;
  modelCheck(modelId: string): Promise<boolean>;
  modelDownload(modelId: string): Promise<LlmDownloadResult>;
  modelDelete(modelId: string): Promise<LlmActionResult>;
  modelDeleteAll(): Promise<LlmActionResult>;
  modelCancelDownload(modelId: string): Promise<{ success: boolean; error?: string }>;
  modelCheckRuntime(): Promise<LlmRuntimeCheckResult>;
  onModelDownloadProgress(callback: (data: LlmDownloadProgressEvent) => void): () => void;
  llamaCppCheck(): Promise<LlamaCppCheckResult>;
  llamaCppInstall(): Promise<LlmActionResult>;
  llamaCppUninstall(): Promise<LlmActionResult>;
  llamaServerStart(modelId: string): Promise<LlamaServerStartResult>;
  llamaServerStop(): Promise<{ success: boolean; error?: string }>;
  llamaServerStatus(): Promise<LlamaServerStatusRow>;
}
