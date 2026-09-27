// Local LLM (llama.cpp) model IPC: catalog with download status, downloads
// with sequence-stamped progress, deletion, runtime availability, the
// llama.cpp installer checks and llama-server lifecycle — moved out of
// ipcHandlers.js behind the shared localLlmModels contract. Semantics are the
// pre-cutover ones 1:1: the download tracker owns progress sequences, a
// DOWNLOAD_IN_PROGRESS failure suppresses the error event, and llama-server
// start persists the runtime env fire-and-forget.
import {
  localLlmChannels,
  type LlamaCppCheckResult,
  type LlamaServerStartResult,
  type LlamaServerStatusRow,
  type LlmActionResult,
  type LlmRuntimeCheckResult,
  type LocalLlmModelStatus,
  type LocalModelDownloadStatusRow,
} from "../contracts/localLlmModels.js";

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

export interface ModelLifecycleProgressSender {
  sendToControlPanel(channel: string, payload: unknown): void;
}

export interface LlmDownloadStatusTracker {
  has(modelType: string, modelId: string): boolean;
  start(modelType: string, modelId: string): unknown;
  update(
    modelType: string,
    modelId: string,
    updates: Partial<Omit<LocalModelDownloadStatusRow, "modelType" | "modelId" | "sequence">>
  ): LocalModelDownloadStatusRow;
  finish(modelType: string, modelId: string): LocalModelDownloadStatusRow | null;
  getActiveDownloads(): LocalModelDownloadStatusRow[];
}

// The narrow manager surfaces this registration consumes; mirrors the strict
// TS ModelManager without coupling to its internals.
export interface LlmModelManagerLike {
  ensureInitialized(): void;
  getModelsWithStatus(): Promise<LocalLlmModelStatus[]>;
  isModelDownloaded(modelId: string): Promise<boolean>;
  downloadModel(
    modelId: string,
    onProgress: (progress: number, downloadedSize: number, totalSize: number) => void
  ): Promise<string>;
  deleteModel(modelId: string): Promise<void>;
  deleteAllModels(): Promise<void>;
  cancelDownload(modelId: string): boolean;
  ensureLlamaCpp(): Promise<boolean>;
  findModelById(modelId: string): { model: { fileName: string }; provider: unknown } | null;
  modelsDir: string | null;
  serverStartOptions(
    modelInfo: unknown,
    overrides?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  serverManager: {
    start(modelPath: string, options?: Record<string, unknown>): Promise<void>;
    port: number | null;
  };
  currentServerModelId: string | null;
  stopServer(): Promise<void>;
  getServerStatus(): LlamaServerStatusRow;
}

export interface LlamaCppInstallerLike {
  isInstalled(): Promise<boolean>;
  install(): Promise<{ success: boolean; message?: string }>;
  uninstall(): Promise<{ success: boolean; message?: string }>;
}

export interface LocalLlmModelDeps {
  modelManager: LlmModelManagerLike;
  llamaCppInstaller: LlamaCppInstallerLike;
  downloadStatus: LlmDownloadStatusTracker;
  progressSender: ModelLifecycleProgressSender;
  joinPath(...segments: string[]): string;
  persistEnvAfterServerStart(): void;
  logError(message: string, data?: unknown): void;
}

function failure(error: unknown): LlmActionResult {
  const err = error as { message?: string; code?: string; details?: unknown };
  return {
    success: false,
    error: err?.message,
    code: err?.code,
    details: err?.details,
  };
}

export function registerLocalLlmModelHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: LocalLlmModelDeps
): void {
  const c = localLlmChannels;

  ipcMain.handle(c.modelGetAll, async (): Promise<unknown> => {
    try {
      const models = await deps.modelManager.getModelsWithStatus();
      return models;
    } catch (error) {
      deps.logError("Error in model-get-all:", error);
      throw error;
    }
  });

  ipcMain.handle(c.modelGetActiveDownloads, async () =>
    deps.downloadStatus.getActiveDownloads()
  );

  // Pre-cutover contract kept 1:1: raw model ids pass straight through to the
  // manager, whose typed errors (MODEL_NOT_FOUND & co) drive the renderer.
  ipcMain.handle(c.modelCheck, async (_event, ...args: unknown[]) => {
    return deps.modelManager.isModelDownloaded(args[0] as string);
  });

  ipcMain.handle(c.modelDownload, async (_event, ...args: unknown[]) => {
    const modelId = args[0] as string;
    if (deps.downloadStatus.has("llm", modelId)) {
      return {
        success: false,
        error: "Model is already being downloaded",
        code: "DOWNLOAD_IN_PROGRESS",
        details: { modelId },
      };
    }
    // Claim ownership before the manager's asynchronous filesystem preflight.
    deps.downloadStatus.start("llm", modelId);
    try {
      const result = await deps.modelManager.downloadModel(
        modelId,
        (progress, downloadedSize, totalSize) => {
          const status = deps.downloadStatus.update("llm", modelId, {
            phase: "downloading",
            progress,
            downloadedBytes: downloadedSize,
            totalBytes: totalSize,
          });
          deps.progressSender.sendToControlPanel(c.modelDownloadProgress, {
            modelId,
            type: "progress",
            progress,
            downloadedSize,
            totalSize,
            sequence: status.sequence,
          });
        }
      );
      const status = deps.downloadStatus.finish("llm", modelId);
      deps.progressSender.sendToControlPanel(c.modelDownloadProgress, {
        modelId,
        type: "complete",
        progress: 100,
        downloadedSize: status?.downloadedBytes,
        totalSize: status?.totalBytes,
        sequence: status?.sequence,
      });
      return { success: true, path: result };
    } catch (error) {
      const status = deps.downloadStatus.finish("llm", modelId);
      const err = error as { message?: string; code?: string; details?: unknown };
      if (err.code !== "DOWNLOAD_IN_PROGRESS") {
        deps.progressSender.sendToControlPanel(c.modelDownloadProgress, {
          modelId,
          type: "error",
          error: err.message,
          code: err.code,
          details: err.details,
          sequence: status?.sequence,
        });
      }
      return {
        success: false,
        error: err.message,
        code: err.code,
        details: err.details,
      };
    }
  });

  ipcMain.handle(c.modelDelete, async (_event, ...args: unknown[]): Promise<LlmActionResult> => {
    try {
      await deps.modelManager.deleteModel(args[0] as string);
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(c.modelDeleteAll, async (): Promise<LlmActionResult> => {
    try {
      await deps.modelManager.deleteAllModels();
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(
    c.modelCancelDownload,
    async (_event, ...args: unknown[]): Promise<{ success: boolean; error?: string }> => {
      try {
        const cancelled = deps.modelManager.cancelDownload(args[0] as string);
        return { success: cancelled };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(c.modelCheckRuntime, async (): Promise<LlmRuntimeCheckResult> => {
    try {
      await deps.modelManager.ensureLlamaCpp();
      return { available: true };
    } catch (error) {
      const err = error as { message?: string; code?: string; details?: unknown };
      return {
        available: false,
        error: err?.message,
        code: err?.code,
        details: err?.details,
      };
    }
  });

  ipcMain.handle(c.llamaCppCheck, async (): Promise<LlamaCppCheckResult> => {
    try {
      const isInstalled = await deps.llamaCppInstaller.isInstalled();
      return { isInstalled, version: null };
    } catch (error) {
      return { isInstalled: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(c.llamaCppInstall, async (): Promise<LlmActionResult> => {
    try {
      return await deps.llamaCppInstaller.install();
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(c.llamaCppUninstall, async (): Promise<LlmActionResult> => {
    try {
      return await deps.llamaCppInstaller.uninstall();
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(
    c.llamaServerStart,
    async (_event, ...args: unknown[]): Promise<LlamaServerStartResult> => {
      const modelId = args[0] as string;
      try {
        const modelManager = deps.modelManager;
        modelManager.ensureInitialized();
        const modelInfo = modelManager.findModelById(modelId);
        if (!modelInfo) {
          return { success: false, error: `Model "${modelId}" not found` };
        }

        const modelPath = deps.joinPath(modelManager.modelsDir as string, modelInfo.model.fileName);

        await modelManager.serverManager.start(
          modelPath,
          await modelManager.serverStartOptions(modelInfo)
        );
        modelManager.currentServerModelId = modelId;

        deps.persistEnvAfterServerStart();
        return { success: true, port: modelManager.serverManager.port ?? undefined };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(c.llamaServerStop, async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await deps.modelManager.stopServer();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(c.llamaServerStatus, async (): Promise<unknown> => {
    try {
      return deps.modelManager.getServerStatus();
    } catch (error) {
      return { available: false, running: false, error: (error as Error).message };
    }
  });
}
