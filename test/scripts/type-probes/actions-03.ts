// @probe-name "the full contract registration and bridge compile under strict settings"
// @probe-codes []
// @probe-origin test/scripts/actionsTypeProbe.test.js
import { registerActionsHandlers } from "./src/helpers/actionsIpcHandlers.js";
import { createActionsBridge } from "./src/preload/actionsBridge.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

registerActionsHandlers(ipcMain, {
  database: {
    getActions: () => [
      {
        id: 1,
        name: "n",
        description: "d",
        prompt: "p",
        icon: "sparkles",
        is_builtin: 1,
        sort_order: 0,
        translation_key: null,
        created_at: "c",
        updated_at: "u",
      },
    ],
    getAction: (id: unknown) => (Number(id) > 0 ? null : null),
    createAction: (name: unknown, description: unknown, prompt: unknown, icon: unknown) => {
      void name;
      void description;
      void prompt;
      void icon;
      return { success: true, action: null };
    },
    updateAction: (id: unknown, updates: unknown) => {
      void id;
      void updates;
      return { success: false, action: null };
    },
    deleteAction: (id: unknown) => {
      void id;
      return { success: false };
    },
  },
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};
const bridge = createActionsBridge(ipcRendererLike);
const dispose = bridge.onActionDeleted((payload) => void payload.id);
dispose();
void bridge.getActions().then((rows) => rows.map((r) => r.translation_key));
