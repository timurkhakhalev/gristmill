// Renderer-facing AI Actions catalog bridge. Moved out of preload.js so the
// five operations and three subscriptions have one typed implementation
// backed by the shared contract. The sandboxed preload can't require local
// modules, so build-main.js bundles the final preload with esbuild before
// packaging.
import {
  actionChannels,
  actionDeleteResultSchema,
  actionDeletedPayloadSchema,
  actionEventChannels,
  actionListResultSchema,
  actionMutationResultSchema,
  actionResultSchema,
  actionSchema,
  type ActionDeletedPayload,
  type ActionMutationResult,
  type ActionUpdateInput,
  type ActionItem,
  type ActionsApi,
} from "../contracts/actions.js";
import type { ZodType } from "zod";

import { subscribeDropped, type IpcRendererLike } from "./ipcTransport.js";

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

// Delegates to the shared transport helper: the callback guard, the listener
// cast and the unsubscribe live in src/preload/ipcTransport.ts.
function subscribeValidated<T>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  schema: ZodType<T>,
  callback: (payload: T) => void
): () => void {
  return subscribeDropped(
    ipcRenderer,
    channel,
    (raw) => {
      const result = schema.safeParse(raw);

      if (result.success) return result.data;

      console.error(`[actionsBridge] dropped malformed ${channel} event`);

      return undefined;
    },
    callback
  );
}

// The return type is the shared ActionsApi, so any drift between this
// implementation and the contract fails compilation instead of review.
export function createActionsBridge(ipcRenderer: IpcRendererLike): ActionsApi {
  return {
    getActions: () =>
      ipcRenderer
        .invoke(actionChannels.getActions)
        .then((raw) => parseResult(actionListResultSchema, raw, actionChannels.getActions)),
    getAction: (id: number) =>
      ipcRenderer
        .invoke(actionChannels.getAction, id)
        .then((raw) => parseResult(actionResultSchema, raw, actionChannels.getAction)),
    createAction: (
      name: string,
      description: string,
      prompt: string,
      icon?: string
    ): Promise<ActionMutationResult> =>
      ipcRenderer
        .invoke(actionChannels.createAction, name, description, prompt, icon)
        .then((raw) => parseResult(actionMutationResultSchema, raw, actionChannels.createAction)),
    updateAction: (id: number, updates: ActionUpdateInput): Promise<ActionMutationResult> =>
      ipcRenderer
        .invoke(actionChannels.updateAction, id, updates)
        .then((raw) => parseResult(actionMutationResultSchema, raw, actionChannels.updateAction)),
    deleteAction: (id: number) =>
      ipcRenderer
        .invoke(actionChannels.deleteAction, id)
        .then((raw) => parseResult(actionDeleteResultSchema, raw, actionChannels.deleteAction)),
    onActionCreated: (callback: (action: ActionItem) => void) =>
      subscribeValidated(ipcRenderer, actionEventChannels.actionCreated, actionSchema, callback),
    onActionUpdated: (callback: (action: ActionItem) => void) =>
      subscribeValidated(ipcRenderer, actionEventChannels.actionUpdated, actionSchema, callback),
    onActionDeleted: (callback: (payload: ActionDeletedPayload) => void) =>
      subscribeValidated(
        ipcRenderer,
        actionEventChannels.actionDeleted,
        actionDeletedPayloadSchema,
        callback
      ),
  };
}
