// @probe-name "a database with the full contract compiles under strict settings"
// @probe-codes []
// @probe-origin test/scripts/containersTypeProbe.test.js
import { registerContainerHandlers } from "./src/helpers/containerIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerContainerHandlers(ipcMain, {
  database: {
    getFolders: (spaceId) => {
      console.log(spaceId);
      return [{ id: 1, name: "F", is_default: 0, sort_order: 0, space_id: 1, created_at: "t", updated_at: "t" }];
    },
    createFolder: (name, spaceId) => {
      console.log(name, spaceId);
      return { success: true, folder: null };
    },
    deleteFolder: (id) => {
      console.log(id);
      return { success: true };
    },
    renameFolder: (id, name) => {
      console.log(id, name);
      return { success: true, folder: null };
    },
    reorderFolders: (spaceId, folderIds) => {
      console.log(spaceId, folderIds);
      return { success: true };
    },
    updateFolderStyle: (id, style) => {
      console.log(id, style);
      return { success: true, folder: null };
    },
    moveFolderToSpace: (id, spaceId) => {
      console.log(id, spaceId);
      return { success: true, folder: null, notes: [] };
    },
    getFolderNoteCounts: () => [],
    getSpaces: () => [],
    updateSpace: (id, updates) => {
      console.log(id, updates);
      return { success: true, space: null };
    },
  },
  noteFilesEnabled: () => false,
  getFolderName: (folderId) => (folderId > 0 ? "F" : null),
  mirrorWriteNote: (note) => {
    console.log(note.id);
  },
  mirrorEnsureFolder: (name) => void name,
  mirrorRenameFolder: (oldName, newName) => void [oldName, newName],
  mirrorDeleteFolderIfUnshared: (name) => void name,
});
