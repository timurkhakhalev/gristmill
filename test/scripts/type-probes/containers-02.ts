// @probe-name "wrong-shaped mirror callbacks fail compilation"
// @probe-codes [2322]
// @probe-origin test/scripts/containersTypeProbe.test.js
import { registerContainerHandlers } from "./src/helpers/containerIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerContainerHandlers(ipcMain, {
  database: {
    getFolders: () => [],
    createFolder: () => ({ success: true, folder: null }),
    deleteFolder: () => ({ success: true }),
    renameFolder: () => ({ success: true, folder: null }),
    moveFolderToSpace: () => ({ success: true, folder: null, notes: [] }),
    getFolderNoteCounts: () => [],
    getSpaces: () => [],
    updateSpace: () => ({ success: true, space: null }),
  },
  noteFilesEnabled: () => false,
  getFolderName: (id: number) => null,
  mirrorWriteNote: (note: { id: string }) => {
    console.log(note.id);
  },
  mirrorEnsureFolder: (name: string) => void name,
  mirrorRenameFolder: (oldName: string, newName: string) => void [oldName, newName],
  mirrorDeleteFolderIfUnshared: (name: string) => void name,
});
