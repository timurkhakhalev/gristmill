// Renderer-facing local model lifecycle bridge: Whisper/Parakeet install
// checks, downloads with progress subscriptions, model status/list/delete,
// server lifecycle, VAD config and diagnostics. The sandboxed preload can't
// require local modules, so build-main.js bundles the final preload.
import {
  downloadProgressEventSchema,
  localModelChannels,
  type DiagnosticsResult,
  type DownloadProgressEvent,
  type FfmpegAvailabilityResult,
  type InstallCheckResult,
  type LocalModelActionResult,
  type LocalModelLifecycleApi,
  type LocalModelListResult,
  type LocalModelStatusRow,
  type ServerLifecycleResult,
  type ServerStatusResult,
  type VadConfigResult,
} from "../contracts/localModelLifecycle.js";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

// The main-side handlers are the only producers of these channels and are
// strict-typed against the same contract interfaces; this single narrowing at
// the deserialization boundary therefore adds no new trust — it rejects
// non-object junk and keeps the shared result types.
function passthroughResult<T extends object>(raw: unknown, channel: string): T {
  if (typeof raw === "object" && raw !== null) {
    return raw as T;
  }

  throw new Error(`Unexpected response shape from ${channel}`);
}

function passthroughInvoke<T extends object>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((raw) => passthroughResult<T>(raw, channel));
}

function subscribeProgress(
  ipcRenderer: IpcRendererLike,
  channel: string,
  callback: (data: DownloadProgressEvent) => void
): () => void {
  const listener = (_event: unknown, ...args: unknown[]) => {
    const parsed = downloadProgressEventSchema.safeParse(args[0]);

    if (!parsed.success) return;
    callback(parsed.data);
  };

  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// The return type is the shared LocalModelLifecycleApi, so any drift between
// this implementation and the contract fails compilation.
export function createLocalModelLifecycleBridge(
  ipcRenderer: IpcRendererLike
): LocalModelLifecycleApi {
  const c = localModelChannels;

  return {
    checkWhisperInstallation: () =>
      passthroughInvoke<InstallCheckResult>(ipcRenderer, c.checkWhisperInstallation),
    downloadWhisperModel: (modelName: string) =>
      passthroughInvoke<LocalModelActionResult>(ipcRenderer, c.downloadWhisperModel, modelName),
    onWhisperDownloadProgress: (callback) =>
      subscribeProgress(ipcRenderer, c.whisperDownloadProgress, callback),
    checkModelStatus: (modelName: string) =>
      passthroughInvoke<LocalModelStatusRow>(ipcRenderer, c.checkModelStatus, modelName),
    listWhisperModels: () =>
      passthroughInvoke<LocalModelListResult>(ipcRenderer, c.listWhisperModels),
    deleteWhisperModel: (modelName: string) =>
      passthroughInvoke<LocalModelActionResult>(ipcRenderer, c.deleteWhisperModel, modelName),
    deleteAllWhisperModels: () =>
      passthroughInvoke<LocalModelActionResult>(ipcRenderer, c.deleteAllWhisperModels),
    cancelWhisperDownload: () =>
      passthroughInvoke<ServerLifecycleResult>(ipcRenderer, c.cancelWhisperDownload),
    whisperServerStart: (modelName: string) =>
      passthroughInvoke<ServerLifecycleResult>(ipcRenderer, c.whisperServerStart, modelName),
    whisperServerStop: () => ipcRenderer.invoke(c.whisperServerStop).then(() => undefined),
    whisperServerStatus: () =>
      passthroughInvoke<ServerStatusResult>(ipcRenderer, c.whisperServerStatus),
    checkFfmpegAvailability: () =>
      passthroughInvoke<FfmpegAvailabilityResult>(ipcRenderer, c.checkFfmpegAvailability),
    getAudioDiagnostics: () =>
      passthroughInvoke<DiagnosticsResult>(ipcRenderer, c.getAudioDiagnostics),
    getWhisperVadConfig: () =>
      passthroughInvoke<VadConfigResult>(ipcRenderer, c.whisperVadGetConfig),
    setWhisperVadConfig: (config) =>
      passthroughInvoke<VadConfigResult>(ipcRenderer, c.whisperVadSetConfig, config),
    checkParakeetInstallation: () =>
      passthroughInvoke<InstallCheckResult>(ipcRenderer, c.checkParakeetInstallation),
    downloadParakeetModel: (modelName: string) =>
      passthroughInvoke<LocalModelActionResult>(ipcRenderer, c.downloadParakeetModel, modelName),
    onParakeetDownloadProgress: (callback) =>
      subscribeProgress(ipcRenderer, c.parakeetDownloadProgress, callback),
    checkParakeetModelStatus: (modelName: string) =>
      passthroughInvoke<LocalModelStatusRow>(ipcRenderer, c.checkParakeetModelStatus, modelName),
    listParakeetModels: () =>
      passthroughInvoke<LocalModelListResult>(ipcRenderer, c.listParakeetModels),
    deleteParakeetModel: (modelName: string) =>
      passthroughInvoke<LocalModelActionResult>(ipcRenderer, c.deleteParakeetModel, modelName),
    deleteAllParakeetModels: () =>
      passthroughInvoke<LocalModelActionResult>(ipcRenderer, c.deleteAllParakeetModels),
    cancelParakeetDownload: () =>
      passthroughInvoke<ServerLifecycleResult>(ipcRenderer, c.cancelParakeetDownload),
    getParakeetDiagnostics: () =>
      passthroughInvoke<DiagnosticsResult>(ipcRenderer, c.getParakeetDiagnostics),
    parakeetServerStart: (modelName: string) =>
      passthroughInvoke<ServerLifecycleResult>(ipcRenderer, c.parakeetServerStart, modelName),
    parakeetServerStop: () => ipcRenderer.invoke(c.parakeetServerStop) as Promise<unknown>,
    parakeetServerStatus: () =>
      passthroughInvoke<ServerStatusResult>(ipcRenderer, c.parakeetServerStatus),
  };
}
