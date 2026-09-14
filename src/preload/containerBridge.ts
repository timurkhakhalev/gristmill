// Renderer-facing containers bridge. Moved out of preload.js so the eight
// operations and the one subscription have one typed implementation backed by
// the shared contract. The sandboxed preload can't require local modules, so
// build-main.js bundles the final preload with esbuild before packaging.
// Events without a renderer consumer (folder-created/renamed/synced,
// space-synced) stay unexposed; onSpacePurged has no producer and is not
// carried over.
import {
  containerChannels,
  containerEventChannels,
  folderDeleteResultSchema,
  folderDeletedPayloadSchema,
  folderListResultSchema,
  folderMoveResultSchema,
  folderMutationResultSchema,
  folderNoteCountsResultSchema,
  spaceListResultSchema,
  spaceMutationResultSchema,
  type ContainersApi,
  type FolderDeletedPayload,
} from "../contracts/containers.js";
import type { ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void
  ): unknown;
}

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
    getFolders: (spaceId?: number | null) =>
      ipcRenderer
        .invoke(containerChannels.getFolders, spaceId)
        .then((raw) =>
          parseResult(folderListResultSchema, raw, containerChannels.getFolders)
        ),
    createFolder: (name: string, spaceId?: number | null) =>
      ipcRenderer
        .invoke(containerChannels.createFolder, name, spaceId)
        .then((raw) =>
          parseResult(folderMutationResultSchema, raw, containerChannels.createFolder)
        ),
    deleteFolder: (id: number) =>
      ipcRenderer
        .invoke(containerChannels.deleteFolder, id)
        .then((raw) =>
          parseResult(folderDeleteResultSchema, raw, containerChannels.deleteFolder)
        ),
    renameFolder: (id: number, name: string) =>
      ipcRenderer
        .invoke(containerChannels.renameFolder, id, name)
        .then((raw) =>
          parseResult(folderMutationResultSchema, raw, containerChannels.renameFolder)
        ),
    moveFolderToSpace: (id: number, spaceId: number) =>
      ipcRenderer
        .invoke(containerChannels.moveFolderToSpace, id, spaceId)
        .then((raw) =>
          parseResult(folderMoveResultSchema, raw, containerChannels.moveFolderToSpace)
        ),
    getFolderNoteCounts: () =>
      ipcRenderer
        .invoke(containerChannels.getFolderNoteCounts)
        .then((raw) =>
          parseResult(
            folderNoteCountsResultSchema,
            raw,
            containerChannels.getFolderNoteCounts
          )
        ),
    getSpaces: () =>
      ipcRenderer
        .invoke(containerChannels.getSpaces)
        .then((raw) =>
          parseResult(spaceListResultSchema, raw, containerChannels.getSpaces)
        ),
    updateSpace: (id: number, updates: { name?: string; emoji?: string | null }) =>
      ipcRenderer
        .invoke(containerChannels.updateSpace, id, updates)
        .then((raw) =>
          parseResult(spaceMutationResultSchema, raw, containerChannels.updateSpace)
        ),
    onFolderDeleted: (callback: (payload: FolderDeletedPayload) => void) => {
      if (typeof callback !== "function") {
        return () => {};
      }
      const listener = (_event: unknown, data: unknown) => {
        const result = folderDeletedPayloadSchema.safeParse(data);
        if (!result.success) {
          console.error(
            `[containersBridge] dropped malformed ${containerEventChannels.folderDeleted} event`
          );
          return;
        }
        callback(result.data);
      };
      ipcRenderer.on(
        containerEventChannels.folderDeleted,
        listener as (event: unknown, ...args: unknown[]) => void
      );
      return () => {
        ipcRenderer.removeListener(
          containerEventChannels.folderDeleted,
          listener as (event: unknown, ...args: unknown[]) => void
        );
      };
    },
  };
}
