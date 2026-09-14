// Single source of truth for the AI Actions catalog vertical: the local
// action row shape, the five DB IPC channels, their results and the three
// change events. Everything is derived from Zod schemas so main, preload
// and renderer share one description.
//
// The schemas mirror the local SQLite `actions` table and the
// DatabaseManager return shapes (src/helpers/database.js). SQLite integer
// flags stay numbers (is_builtin: 0 | 1), not booleans. Catalog CRUD only —
// action execution lives in useActionProcessing/actionProcessingStore.
import { z } from "zod";

const nonNegativeInt = z.number().int();
const idArg = nonNegativeInt;

export const actionSchema = z.object({
  id: nonNegativeInt,
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  icon: z.string(),
  is_builtin: z.union([z.literal(0), z.literal(1)]),
  sort_order: z.number(),
  translation_key: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ActionItem = z.infer<typeof actionSchema>;

// Positional arguments are frozen API: renderer preload and main handlers
// both bind to them. Ids stay strict; name/description/prompt/icon and the
// update payload stay tolerant — the DB layer owns trimming, whitelisting
// and the success:false outcomes.
export const getActionsArgsSchema = z.tuple([]);
export const getActionArgsSchema = z.tuple([idArg]);
export const createActionArgsSchema = z.tuple([
  z.unknown(),
  z.unknown(),
  z.unknown(),
  z.unknown().optional(),
]);
export const updateActionArgsSchema = z.tuple([idArg, z.unknown()]);
export const deleteActionArgsSchema = z.tuple([idArg]);

// getAction(id) yields null for a missing row; update re-reads the row, so
// a missing id carries action:null.
export const actionResultSchema = actionSchema.nullable();
export const actionMutationResultSchema = z.object({
  success: z.boolean(),
  action: actionSchema.nullish(),
  error: z.string().optional(),
});
export type ActionMutationResult = z.infer<typeof actionMutationResultSchema>;
// deleteAction never carries the row back; builtins and unknown ids
// report plain success:false.
export const actionDeleteResultSchema = z.object({ success: z.boolean() });
export const actionListResultSchema = z.array(actionSchema);

// Event payloads: create/update carry the full verified local row; delete
// only carries the id the handler was called with.
export const actionCreatedPayloadSchema = actionSchema;
export const actionUpdatedPayloadSchema = actionSchema;
export const actionDeletedPayloadSchema = z.object({ id: idArg });
export type ActionDeletedPayload = z.infer<typeof actionDeletedPayloadSchema>;

// The renderer-facing surface: five operations, three subscriptions.
export interface ActionUpdateInput {
  name?: string;
  description?: string;
  prompt?: string;
  icon?: string;
  sort_order?: number;
}

export interface ActionsApi {
  getActions(): Promise<ActionItem[]>;
  getAction(id: number): Promise<ActionItem | null>;
  createAction(
    name: string,
    description: string,
    prompt: string,
    icon?: string
  ): Promise<ActionMutationResult>;
  updateAction(id: number, updates: ActionUpdateInput): Promise<ActionMutationResult>;
  deleteAction(id: number): Promise<{ success: boolean }>;
  onActionCreated(callback: (action: ActionItem) => void): () => void;
  onActionUpdated(callback: (action: ActionItem) => void): () => void;
  onActionDeleted(callback: (payload: ActionDeletedPayload) => void): () => void;
}

export const actionChannels = {
  getActions: "db-get-actions",
  getAction: "db-get-action",
  createAction: "db-create-action",
  updateAction: "db-update-action",
  deleteAction: "db-delete-action",
} as const;

export const actionEventChannels = {
  actionCreated: "action-created",
  actionUpdated: "action-updated",
  actionDeleted: "action-deleted",
} as const;
