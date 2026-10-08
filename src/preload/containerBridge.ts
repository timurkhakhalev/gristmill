// Renderer-facing folders bridge. Moved out of preload.js so the
// operations and the one subscription have one typed implementation backed by
// the shared contract. The sandboxed preload can't require local modules, so
// build-main.js bundles the final preload with esbuild before packaging.
// Events without a renderer consumer stay unexposed.
import {
  containerChannels,
  containerEventChannels,
  folderDeleteResultSchema,
  folderDeletedPayloadSchema,
  folderListResultSchema,
  folderMutationResultSchema,
  folderNoteCountsResultSchema,
  type ContainersApi,
  type FolderDeletedPayload,
  type FolderStyle,
} from "../contracts/containers.js";
import type { ZodType } from "zod";

import { subscribeDropped, type IpcRendererLike } from "./ipcTransport.js";

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

// The return type is the shared ContainersApi, so any drift between this
// implementation and the contract fails compilation instead of review.
export function createContainersBridge(ipcRenderer: IpcRendererLike): ContainersApi {
  return {
    getFolders: () =>
      ipcRenderer
        .invoke(containerChannels.getFolders)
        .then((raw) => parseResult(folderListResultSchema, raw, containerChannels.getFolders)),
    createFolder: (name: string) =>
      ipcRenderer
        .invoke(containerChannels.createFolder, name)
        .then((raw) =>
          parseResult(folderMutationResultSchema, raw, containerChannels.createFolder)
        ),
    deleteFolder: (id: number) =>
      ipcRenderer
        .invoke(containerChannels.deleteFolder, id)
        .then((raw) => parseResult(folderDeleteResultSchema, raw, containerChannels.deleteFolder)),
    renameFolder: (id: number, name: string) =>
      ipcRenderer
        .invoke(containerChannels.renameFolder, id, name)
        .then((raw) =>
          parseResult(folderMutationResultSchema, raw, containerChannels.renameFolder)
        ),
    updateFolderStyle: (id: number, style: FolderStyle) =>
      ipcRenderer
        .invoke(containerChannels.updateFolderStyle, id, style)
        .then((raw) =>
          parseResult(folderMutationResultSchema, raw, containerChannels.updateFolderStyle)
        ),
    reorderFolders: (folderIds: number[]) =>
      ipcRenderer
        .invoke(containerChannels.reorderFolders, folderIds)
        .then((raw) =>
          parseResult(folderDeleteResultSchema, raw, containerChannels.reorderFolders)
        ),
    getFolderNoteCounts: () =>
      ipcRenderer
        .invoke(containerChannels.getFolderNoteCounts)
        .then((raw) =>
          parseResult(folderNoteCountsResultSchema, raw, containerChannels.getFolderNoteCounts)
        ),
    onFolderDeleted: (callback: (payload: FolderDeletedPayload) => void) =>
      subscribeDropped(
        ipcRenderer,
        containerEventChannels.folderDeleted,
        (raw) => {
          const result = folderDeletedPayloadSchema.safeParse(raw);

          if (result.success) return result.data;

          console.error(
            `[containersBridge] dropped malformed ${containerEventChannels.folderDeleted} event`
          );

          return undefined;
        },
        callback
      ),
  };
}
