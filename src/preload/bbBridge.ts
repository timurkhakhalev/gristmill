import {
  bbChannels,
  bbHarnessSchema,
  bbHostPreferencesSchema,
  bbModelSchema,
  bbStreamEnvelopeSchema,
  type BbApi,
  type BbSelection,
} from "../contracts/bb.js";
import { z } from "zod";

import type { IpcRendererLike } from "./ipcTransport.js";

export function createBbBridge(ipc: IpcRendererLike): BbApi {
  return {
    bbCatalog: async () => z.array(bbHarnessSchema).parse(await ipc.invoke(bbChannels.catalog)),
    bbHostPreferences: async () =>
      bbHostPreferencesSchema.parse(await ipc.invoke(bbChannels.hostPreferences)),
    bbModels: async (provider) =>
      z.array(bbModelSchema).parse(await ipc.invoke(bbChannels.models, provider)),
    bbStreamStart: async (request) => {
      await ipc.invoke(bbChannels.streamStart, request);
    },
    bbStreamCancel: async (streamId) => {
      await ipc.invoke(bbChannels.streamCancel, streamId);
    },
    onBbStreamPart: (callback) => {
      const listener = (_event: unknown, payload: unknown) => {
        const parsed = bbStreamEnvelopeSchema.safeParse(payload);

        if (parsed.success) callback(parsed.data);
      };

      ipc.on(bbChannels.streamPart, listener);

      return () => ipc.removeListener(bbChannels.streamPart, listener);
    },
    bbGenerate: async (prompt: string, selection: BbSelection) => {
      const result = await ipc.invoke(bbChannels.generate, prompt, selection);

      return z.string().parse(result);
    },
  };
}
