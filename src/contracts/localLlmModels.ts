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

// One bundled local LLM as the renderer sees it: the registry entry plus the
// download snapshot. The index signature keeps the renderer's consumers
// working while pinning the fields every consumer reads.
// Mirrors the registry's ModelDefinition fields (the manager spreads the
// registry entry onto the wire row) without importing the renderer-side
// ModelRegistry module into the main graph.
export interface LocalLlmModelStatus {
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
  description: string;
  descriptionKey?: string;
  fileName: string;
  quantization: string;
  contextLength: number;
  hfRepo: string;
  recommended?: boolean;
  supportsThinking?: boolean;
  draftHfRepo?: string;
  draftFileName?: string;
  draftSizeBytes?: number;
  providerId: string;
  providerName: string;
  isDownloaded: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  downloadedSize: number;
  totalSize: number;
  path: string | null;
}

// Wire shape of the shared native/LLM download status tracker rows.
export interface LocalModelDownloadStatusRow {
  modelType: "whisper" | "parakeet" | "llm";
  modelId: string;
  phase: "downloading" | "installing";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  sequence: number;
}

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
