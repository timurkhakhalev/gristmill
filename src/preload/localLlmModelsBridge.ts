// Renderer-facing local LLM bridge: model catalog with download status,
// downloads with a schema-validated progress subscription, deletion, runtime
// availability, llama.cpp installer checks and llama-server lifecycle. The
// sandboxed preload can't require local modules, so build-main.js bundles the
// final preload.
import {
  llmDownloadProgressEventSchema,
  localLlmChannels,
  type LlamaCppCheckResult,
  type LlamaServerStartResult,
  type LlamaServerStatusRow,
  type LlmActionResult,
  type LlmDownloadProgressEvent,
  type LlmDownloadResult,
  type LlmRuntimeCheckResult,
  type LocalLlmModelStatus,
  type LocalLlmModelsApi,
  type LocalModelDownloadStatusRow,
} from "../contracts/localLlmModels.js";

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
  callback: (data: LlmDownloadProgressEvent) => void
): () => void {
  const listener = (_event: unknown, ...args: unknown[]) => {
    const parsed = llmDownloadProgressEventSchema.safeParse(args[0]);
    if (!parsed.success) return;
    callback(parsed.data);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

export function createLocalLlmModelsBridge(ipcRenderer: IpcRendererLike): LocalLlmModelsApi {
  const c = localLlmChannels;

  return {
    modelGetAll: () => passthroughInvoke<LocalLlmModelStatus[]>(ipcRenderer, c.modelGetAll),
    modelGetActiveDownloads: () =>
      passthroughInvoke<LocalModelDownloadStatusRow[]>(ipcRenderer, c.modelGetActiveDownloads),
    modelCheck: (modelId: string) =>
      ipcRenderer.invoke(c.modelCheck, modelId) as Promise<boolean>,
    modelDownload: (modelId: string) =>
      passthroughInvoke<LlmDownloadResult>(ipcRenderer, c.modelDownload, modelId),
    modelDelete: (modelId: string) =>
      passthroughInvoke<LlmActionResult>(ipcRenderer, c.modelDelete, modelId),
    modelDeleteAll: () => passthroughInvoke<LlmActionResult>(ipcRenderer, c.modelDeleteAll),
    modelCancelDownload: (modelId: string) =>
      passthroughInvoke<{ success: boolean; error?: string }>(
        ipcRenderer,
        c.modelCancelDownload,
        modelId
      ),
    modelCheckRuntime: () =>
      passthroughInvoke<LlmRuntimeCheckResult>(ipcRenderer, c.modelCheckRuntime),
    onModelDownloadProgress: (callback) =>
      subscribeProgress(ipcRenderer, c.modelDownloadProgress, callback),
    llamaCppCheck: () => passthroughInvoke<LlamaCppCheckResult>(ipcRenderer, c.llamaCppCheck),
    llamaCppInstall: () => passthroughInvoke<LlmActionResult>(ipcRenderer, c.llamaCppInstall),
    llamaCppUninstall: () => passthroughInvoke<LlmActionResult>(ipcRenderer, c.llamaCppUninstall),
    llamaServerStart: (modelId: string) =>
      passthroughInvoke<LlamaServerStartResult>(ipcRenderer, c.llamaServerStart, modelId),
    llamaServerStop: () =>
      passthroughInvoke<{ success: boolean; error?: string }>(ipcRenderer, c.llamaServerStop),
    llamaServerStatus: () =>
      passthroughInvoke<LlamaServerStatusRow>(ipcRenderer, c.llamaServerStatus),
  };
}
