// @probe-name "an incomplete database dependency fails compilation"
// @probe-codes [2741]
// @probe-origin test/scripts/containersTypeProbe.test.js
import { registerContainerHandlers } from "./src/helpers/containerIpcHandlers.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

// A database missing updateSpace would leave the space channel dead while
// every folder channel keeps working; the compiler must reject the
// registration instead.
registerContainerHandlers(ipcMain, {
  database: {
    getFolders: () => [],
    createFolder: () => ({ success: true, folder: null }),
    deleteFolder: () => ({ success: true }),
    renameFolder: () => ({ success: true, folder: null }),
    updateFolderStyle: () => ({ success: true, folder: null }),
    reorderFolders: () => ({ success: true }),
    moveFolderToSpace: () => ({ success: true, folder: null, notes: [] }),
    getFolderNoteCounts: () => [],
    getSpaces: () => [],
  },
  noteFilesEnabled: () => false,
  getFolderName: () => null,
  mirrorWriteNote: () => {},
  mirrorEnsureFolder: () => {},
  mirrorRenameFolder: () => {},
  mirrorDeleteFolderIfUnshared: () => {},
});
