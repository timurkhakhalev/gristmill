// The single sender for the three AI Actions catalog events. The only
// producers are the five catalog handlers, so a malformed payload from
// JS-land is dropped and diagnosed instead of reaching renderers. A bad
// payload must never break the already-completed DB operation, so a
// validation failure only logs.
import { broadcastToWindows } from "./windowBroadcast.js";
import {
  actionCreatedPayloadSchema,
  actionDeletedPayloadSchema,
  actionEventChannels,
  actionUpdatedPayloadSchema,
} from "../contracts/actions.js";
import type { ZodType } from "zod";

function parseOrDrop<T>(channel: string, payload: unknown, schema: ZodType<T>): T | null {
  const result = schema.safeParse(payload);

  if (!result.success) {
    console.error(
      `[actionsEvents] dropped malformed ${channel} payload: ${result.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );

    return null;
  }

  return result.data;
}

export function sendActionCreated(action: unknown): void {
  const valid = parseOrDrop(actionEventChannels.actionCreated, action, actionCreatedPayloadSchema);

  if (valid) broadcastToWindows(actionEventChannels.actionCreated, valid);
}

export function sendActionUpdated(action: unknown): void {
  const valid = parseOrDrop(actionEventChannels.actionUpdated, action, actionUpdatedPayloadSchema);

  if (valid) broadcastToWindows(actionEventChannels.actionUpdated, valid);
}

export function sendActionDeleted(payload: unknown): void {
  const valid = parseOrDrop(actionEventChannels.actionDeleted, payload, actionDeletedPayloadSchema);

  if (valid) broadcastToWindows(actionEventChannels.actionDeleted, valid);
}
