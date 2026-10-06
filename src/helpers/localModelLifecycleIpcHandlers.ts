// `quality/no-unknown-parameters` / `no-unknown-returns` are off for this file
// (exact-file override): it registers ipcMain.handle listeners, whose event and
// variadic arguments are untrusted and parsed per channel below.
// The local Whisper/Parakeet model lifecycle handlers, moved out of
// ipcHandlers.js. Downloads flow through the shared status tracker
// (sequence-stamped progress to the control panel), failures keep their
// manager error codes, and the parakeet server start/stop persists the
// provider selection in .env exactly as before. VAD config validation and
// persistence stay in the injected settings owner.
import {
  localModelChannels,
  modelNameSchema,
  type DiagnosticsResult,
  type WhisperVadConfigUpdate,
  type WhisperVadWireConfig,
  whisperVadConfigUpdateSchema,
  type DownloadProgressEvent,
  type FfmpegAvailabilityResult,
  type InstallCheckResult,
  type LocalModelActionResult,
  type LocalModelListResult,
  type LocalModelStatusRow,
  type ServerLifecycleResult,
  type ServerStatusResult,
} from "../contracts/localModelLifecycle.js";

// The ipcMain.handle listener surface: an untrusted invocation event and
// variable arguments, both parsed per channel below.
type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

export interface ModelLifecycleProgressSender {
  sendToControlPanel(channel: string, payload: DownloadProgressEvent & { sequence?: number }): void;
}

export interface DownloadStatusTracker {
  has(modelType: string, modelId: string): boolean;
  start(modelType: string, modelId: string): void;
  finish(modelType: string, modelId: string): { sequence: number } | null;
}

export interface LocalModelLifecycleDeps {
  whisperManager: WhisperManagerLike;
  parakeetManager: ParakeetManagerLike;
  downloadStatus: DownloadStatusTracker;
  progressSender: ModelLifecycleProgressSender;
  updateDownloadStatus(
    modelType: string,
    modelId: string,
    progressData: DownloadProgressEvent
  ): { sequence: number } | null;
  getWhisperVadSettings(): WhisperVadWireConfig;
  setWhisperVadSettings(payload: WhisperVadConfigUpdate): WhisperVadWireConfig;
  persistParakeetProviderSelection(modelName: string): Promise<void>;
  clearParakeetProviderSelection(): Promise<void>;
  resolveParakeetProviderName(modelName: string): "cohere" | "nvidia";
  logError(message: string, data?: unknown): void;
}

// The narrow manager surfaces this registration consumes; mirrors the strict
// TS manager classes without coupling to their internals.
export interface WhisperManagerLike {
  checkWhisperInstallation(): Promise<InstallCheckResult>;
  downloadWhisperModel(
    modelName: string,
    onProgress: (event: DownloadProgressEvent) => void
  ): Promise<LocalModelActionResult>;
  checkModelStatus(modelName: string): Promise<LocalModelStatusRow>;
  listWhisperModels(): Promise<LocalModelListResult>;
  deleteWhisperModel(modelName: string): Promise<LocalModelActionResult>;
  deleteAllWhisperModels(): Promise<LocalModelActionResult>;
  cancelDownload(): Promise<ServerLifecycleResult>;
  startServer(modelName: string): Promise<ServerLifecycleResult>;
  stopServer(): Promise<void>;
  getServerStatus(): ServerStatusResult;
  checkFFmpegAvailability(): Promise<FfmpegAvailabilityResult>;
  getDiagnostics(): Promise<DiagnosticsResult>;
}

export interface ParakeetManagerLike {
  checkInstallation(): Promise<InstallCheckResult>;
  downloadParakeetModel(
    modelName: string,
    onProgress: (event: DownloadProgressEvent) => void
  ): Promise<LocalModelActionResult>;
  checkModelStatus(modelName: string): Promise<LocalModelStatusRow>;
  listParakeetModels(): Promise<LocalModelListResult>;
  deleteParakeetModel(modelName: string): Promise<LocalModelActionResult>;
  deleteAllParakeetModels(): Promise<LocalModelActionResult>;
  cancelDownload(): Promise<ServerLifecycleResult>;
  getDiagnostics(): Promise<DiagnosticsResult>;
  startServer(modelName: string): Promise<ServerLifecycleResult>;
  stopServer(): Promise<void>;
  getServerStatus(): ServerStatusResult;
}

function runManagedDownload(
  deps: LocalModelLifecycleDeps,
  modelType: "whisper" | "parakeet",
  modelName: string,
  download: (onProgress: (event: DownloadProgressEvent) => void) => Promise<LocalModelActionResult>
): Promise<LocalModelActionResult> {
  const hadActiveDownload = deps.downloadStatus.has(modelType, modelName);
  deps.downloadStatus.start(modelType, modelName);

  const channel =
    modelType === "whisper"
      ? localModelChannels.whisperDownloadProgress
      : localModelChannels.parakeetDownloadProgress;

  return download((progressData) => {
    const status = deps.updateDownloadStatus(modelType, modelName, progressData);
    deps.progressSender.sendToControlPanel(channel, {
      ...progressData,
      sequence: status?.sequence,
    });
  })
    .then((result) => {
      const status = deps.downloadStatus.has(modelType, modelName)
        ? deps.downloadStatus.finish(modelType, modelName)
        : null;

      if (status) {
        deps.progressSender.sendToControlPanel(channel, {
          type: "complete",
          model: modelName,
          percentage: 100,
          sequence: status.sequence,
        });
      }

      return result;
    })
    .catch((error: { message?: string; code?: string }) => {
      const status = hadActiveDownload ? null : deps.downloadStatus.finish(modelType, modelName);

      if (!hadActiveDownload && error.code !== "DOWNLOAD_IN_PROGRESS") {
        deps.progressSender.sendToControlPanel(channel, {
          type: "error",
          model: modelName,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
          sequence: status?.sequence,
        });
      }

      return {
        success: false,
        error: error.message,
        code: error.code || "DOWNLOAD_FAILED",
      };
    });
}

export function registerLocalModelLifecycleHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: LocalModelLifecycleDeps
): void {
  const c = localModelChannels;

  ipcMain.handle(c.checkWhisperInstallation, async (): Promise<unknown> =>
    deps.whisperManager.checkWhisperInstallation()
  );

  ipcMain.handle(c.getAudioDiagnostics, async (): Promise<unknown> =>
    deps.whisperManager.getDiagnostics()
  );

  ipcMain.handle(c.downloadWhisperModel, async (_event, ...args: unknown[]) => {
    const parsed = modelNameSchema.safeParse(args[0]);

    if (!parsed.success) {
      return { success: false, error: "Invalid model name" };
    }

    return runManagedDownload(deps, "whisper", parsed.data, (onProgress) =>
      deps.whisperManager.downloadWhisperModel(parsed.data, onProgress)
    );
  });

  ipcMain.handle(c.checkModelStatus, async (_event, ...args: unknown[]) => {
    const parsed = modelNameSchema.safeParse(args[0]);

    if (!parsed.success) {
      return { success: false, error: "Invalid model name" };
    }

    return deps.whisperManager.checkModelStatus(parsed.data);
  });

  ipcMain.handle(c.listWhisperModels, async () => deps.whisperManager.listWhisperModels());
  ipcMain.handle(c.deleteWhisperModel, async (_event, ...args: unknown[]) => {
    const parsed = modelNameSchema.safeParse(args[0]);

    if (!parsed.success) {
      return { success: false, error: "Invalid model name" };
    }

    return deps.whisperManager.deleteWhisperModel(parsed.data);
  });
  ipcMain.handle(c.deleteAllWhisperModels, async () =>
    deps.whisperManager.deleteAllWhisperModels()
  );
  ipcMain.handle(c.cancelWhisperDownload, async () => deps.whisperManager.cancelDownload());
  ipcMain.handle(c.whisperServerStart, async (_event, ...args: unknown[]) => {
    const parsed = modelNameSchema.safeParse(args[0]);

    if (!parsed.success) {
      return { success: false, reason: "Invalid model name" };
    }

    return deps.whisperManager.startServer(parsed.data);
  });
  ipcMain.handle(c.whisperServerStop, async () => deps.whisperManager.stopServer());
  ipcMain.handle(c.whisperServerStatus, async () => deps.whisperManager.getServerStatus());
  ipcMain.handle(c.checkFfmpegAvailability, async () =>
    deps.whisperManager.checkFFmpegAvailability()
  );

  ipcMain.handle(c.whisperVadGetConfig, async () => {
    try {
      return { success: true, config: deps.getWhisperVadSettings() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // Pre-cutover contract, kept 1:1: set never rejects — the settings owner
  // filters allowed keys on write and sanitizes/clamps on read, so the
  // returned config is always a valid merged view.
  ipcMain.handle(c.whisperVadSetConfig, async (_event, ...args: unknown[]) => {
    try {
      // The settings owner filters allowed keys on write and sanitizes/clamps
      // on read, so a partially-shaped update is safe to forward.
      const parsed = whisperVadConfigUpdateSchema.safeParse(args[0] ?? {});
      const config = deps.setWhisperVadSettings(parsed.success ? parsed.data : {});

      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(c.checkParakeetInstallation, async () => deps.parakeetManager.checkInstallation());

  ipcMain.handle(c.downloadParakeetModel, async (_event, ...args: unknown[]) => {
    const parsed = modelNameSchema.safeParse(args[0]);

    if (!parsed.success) {
      return { success: false, error: "Invalid model name" };
    }

    return runManagedDownload(deps, "parakeet", parsed.data, (onProgress) =>
      deps.parakeetManager.downloadParakeetModel(parsed.data, onProgress)
    );
  });

  ipcMain.handle(c.checkParakeetModelStatus, async (_event, ...args: unknown[]) => {
    const parsed = modelNameSchema.safeParse(args[0]);

    if (!parsed.success) {
      return { success: false, error: "Invalid model name" };
    }

    return deps.parakeetManager.checkModelStatus(parsed.data);
  });

  ipcMain.handle(c.listParakeetModels, async () => deps.parakeetManager.listParakeetModels());
  ipcMain.handle(c.deleteParakeetModel, async (_event, ...args: unknown[]) => {
    const parsed = modelNameSchema.safeParse(args[0]);

    if (!parsed.success) {
      return { success: false, error: "Invalid model name" };
    }

    return deps.parakeetManager.deleteParakeetModel(parsed.data);
  });
  ipcMain.handle(c.deleteAllParakeetModels, async () =>
    deps.parakeetManager.deleteAllParakeetModels()
  );
  ipcMain.handle(c.cancelParakeetDownload, async () => deps.parakeetManager.cancelDownload());
  ipcMain.handle(c.getParakeetDiagnostics, async () => deps.parakeetManager.getDiagnostics());

  ipcMain.handle(c.parakeetServerStart, async (_event, ...args: unknown[]) => {
    const parsed = modelNameSchema.safeParse(args[0]);

    if (!parsed.success) {
      return { success: false, reason: "Invalid model name" };
    }

    const result = await deps.parakeetManager.startServer(parsed.data);

    // Persisting a provider that failed to start would wedge every launch
    // into a failing pre-warm.
    if (result.success) {
      await deps.persistParakeetProviderSelection(parsed.data);
    }

    return result;
  });

  ipcMain.handle(c.parakeetServerStop, async () => {
    const result = await deps.parakeetManager.stopServer();
    await deps.clearParakeetProviderSelection();

    return result;
  });

  ipcMain.handle(c.parakeetServerStatus, async () => deps.parakeetManager.getServerStatus());
}
