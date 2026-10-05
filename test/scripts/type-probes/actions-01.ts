// @probe-name "an incomplete database dependency fails compilation"
// @probe-codes [2741]
// @probe-origin test/scripts/actionsTypeProbe.test.js
import { registerActionsHandlers } from "./src/helpers/actionsIpcHandlers.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

// A database missing deleteAction would leave the delete channel dead while
// the rest keep working; the compiler must reject the registration.
registerActionsHandlers(ipcMain, {
  database: {
    getActions: () => [],
    getAction: () => null,
    createAction: () => ({ success: true, action: null }),
    updateAction: () => ({ success: true, action: null }),
  },
});
