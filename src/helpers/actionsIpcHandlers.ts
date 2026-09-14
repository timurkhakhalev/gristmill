// The five AI Actions catalog DB channels, moved out of ipcHandlers.js.
// Registration order, positional arguments, return shapes and event side
// effects match the previous JS implementations; SQL stays in
// DatabaseManager. Arguments are accepted as unknown, validated with the
// shared tuple schemas, and only validated results/events reach the wire.
import type { ZodType } from "zod";
import {
  actionDeleteResultSchema,
  actionDeletedPayloadSchema,
  actionListResultSchema,
  actionMutationResultSchema,
  actionResultSchema,
  createActionArgsSchema,
  deleteActionArgsSchema,
  getActionArgsSchema,
  getActionsArgsSchema,
  updateActionArgsSchema,
  type ActionDeletedPayload,
} from "../contracts/actions.js";
import { sendActionCreated, sendActionDeleted, sendActionUpdated } from "./actionsEvents.js";

export interface ActionsHandlerDeps {
  database: {
    getActions: () => unknown;
    getAction: (id: unknown) => unknown;
    createAction: (
      name: unknown,
      description: unknown,
      prompt: unknown,
      icon: unknown
    ) => unknown;
    updateAction: (id: unknown, updates: unknown) => unknown;
    deleteAction: (id: unknown) => unknown;
  };
}

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

// Throw before the DB is touched when the renderer sent a wrong-shaped call.
function parseArgs<T>(schema: ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new Error("Invalid arguments for an actions IPC call");
  }
  return result.data;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, what: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`DatabaseManager returned an unexpected ${what}`);
  }
  return result.data;
}

export function registerActionsHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: ActionsHandlerDeps
): void {
  const { database } = deps;

  ipcMain.handle("db-get-actions", async (_event, ...args: unknown[]) => {
    parseArgs(getActionsArgsSchema, args);
    return parseResult(actionListResultSchema, database.getActions(), "action list shape");
  });

  ipcMain.handle("db-get-action", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(getActionArgsSchema, args);
    return parseResult(actionResultSchema, database.getAction(id), "action row");
  });

  ipcMain.handle("db-create-action", async (_event, ...args: unknown[]) => {
    const [name, description, prompt, icon] = parseArgs(createActionArgsSchema, args);
    const result = parseResult(
      actionMutationResultSchema,
      database.createAction(name, description, prompt, icon),
      "action mutation result"
    );
    if (result.success && result.action) {
      setImmediate(() => sendActionCreated(result.action));
    }
    return result;
  });

  ipcMain.handle("db-update-action", async (_event, ...args: unknown[]) => {
    const [id, updates] = parseArgs(updateActionArgsSchema, args);
    const result = parseResult(
      actionMutationResultSchema,
      database.updateAction(id, updates),
      "action mutation result"
    );
    if (result.success && result.action) {
      setImmediate(() => sendActionUpdated(result.action));
    }
    return result;
  });

  ipcMain.handle("db-delete-action", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(deleteActionArgsSchema, args);
    const result = parseResult(
      actionDeleteResultSchema,
      database.deleteAction(id),
      "action delete result"
    );
    if (result.success) {
      setImmediate(() => {
        const payload: ActionDeletedPayload = { id };
        sendActionDeleted(payload);
      });
    }
    return result;
  });
}
