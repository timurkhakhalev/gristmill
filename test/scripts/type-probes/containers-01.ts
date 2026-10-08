// @probe-name "an incomplete database dependency fails compilation"
// @probe-codes [2741]
// @probe-origin test/scripts/containersTypeProbe.test.js
import { registerContainerHandlers } from "./src/helpers/containerIpcHandlers.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

// A database missing the folder count operation leaves the sidebar counts
// unavailable; the compiler must reject the registration.
registerContainerHandlers(ipcMain, {
  database: {
    getFolders: () => [],
    createFolder: () => ({ success: true, folder: null }),
    deleteFolder: () => ({ success: true }),
    renameFolder: () => ({ success: true, folder: null }),
    updateFolderStyle: () => ({ success: true, folder: null }),
    reorderFolders: () => ({ success: true }),
  },
  noteFilesEnabled: () => false,
  getFolderName: () => null,
  mirrorWriteNote: () => {},
  mirrorEnsureFolder: () => {},
  mirrorRenameFolder: () => {},
  mirrorDeleteFolderIfUnshared: () => {},
});
