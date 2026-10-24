// Renderer-facing local LLM bridge: model catalog with download status,
// downloads with a schema-validated progress subscription, deletion, runtime
// availability, llama.cpp installer checks and llama-server lifecycle. The
// sandboxed preload can't require local modules, so build-main.js bundles the
// final preload.
import {
  llmDownloadProgressEventSchema,
  localLlmChannels,
  localLlmModelStatusSchema,
  localModelDownloadStatusRowSchema,
  type LlamaCppCheckResult,
  type LlamaServerStartResult,
  type LlamaServerStatusRow,
  type LlmActionResult,
  type LlmDownloadProgressEvent,
  type LlmDownloadResult,
  type LlmRuntimeCheckResult,
  type LocalLlmModelsApi,
} from "../contracts/localLlmModels.js";
import { z, type ZodType } from "zod";

import type { IpcRendererLike } from "./ipcTransport.js";

// The main-side handlers are the only producers of these channels and are
// strict-typed against the same contract interfaces; this single narrowing at
// the deserialization boundary therefore adds no new trust — it rejects
// non-object junk and keeps the shared result types.
const objectSchema = z.record(z.string(), z.unknown());

function passthroughResult<T extends object>(raw: unknown, channel: string): T {
  if (objectSchema.safeParse(raw).success) {
    // SAFETY: the record parse above rejected non-object transport junk, and
    // the main-side handlers are strict-typed against these same contract
    // interfaces — the assertion re-voices the checked result shape.
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

function parseList<T>(schema: ZodType<T>, raw: unknown, channel: string): T[] {
  const result = z.array(schema).safeParse(raw);

  if (!result.success) throw new Error(`Unexpected response shape from ${channel}`);

  return result.data;
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
    modelGetAll: async () =>
      parseList(localLlmModelStatusSchema, await ipcRenderer.invoke(c.modelGetAll), c.modelGetAll),
    modelGetActiveDownloads: async () =>
      parseList(
        localModelDownloadStatusRowSchema,
        await ipcRenderer.invoke(c.modelGetActiveDownloads),
        c.modelGetActiveDownloads
      ),
    // SAFETY: the handler parses the id with the shared model-name schema and
    // answers a plain boolean; the cast re-voices the checked wire shape.
    modelCheck: (modelId: string) => ipcRenderer.invoke(c.modelCheck, modelId) as Promise<boolean>,
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
