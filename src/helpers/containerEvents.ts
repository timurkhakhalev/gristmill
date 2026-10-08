// The single sender for the five folder/space events. Every producer — the
// typed handlers in containerIpcHandlers.ts and the CLI bridge — goes through
// here so a malformed payload from JS-land is dropped and diagnosed instead of
// reaching renderers. A bad payload must never break the already-completed DB
// operation or the remaining side effects, so a validation failure only logs.
import { broadcastToWindows } from "./windowBroadcast.js";
import {
  containerEventChannels,
  folderCreatedRenamedSyncedPayloadSchema,
  folderDeletedPayloadSchema,
} from "../contracts/containers.js";
import type { ZodType } from "zod";

function parseOrDrop<T>(channel: string, payload: unknown, schema: ZodType<T>): T | null {
  const result = schema.safeParse(payload);

  if (!result.success) {
    console.error(
      `[containerEvents] dropped malformed ${channel} payload: ${result.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );

    return null;
  }

  return result.data;
}

export function sendFolderCreated(folder: unknown): void {
  const valid = parseOrDrop(
    containerEventChannels.folderCreated,
    folder,
    folderCreatedRenamedSyncedPayloadSchema
  );

  if (valid) broadcastToWindows(containerEventChannels.folderCreated, valid);
}

export function sendFolderDeleted(payload: unknown): void {
  const valid = parseOrDrop(
    containerEventChannels.folderDeleted,
    payload,
    folderDeletedPayloadSchema
  );

  if (valid) broadcastToWindows(containerEventChannels.folderDeleted, valid);
}

export function sendFolderRenamed(folder: unknown): void {
  const valid = parseOrDrop(
    containerEventChannels.folderRenamed,
    folder,
    folderCreatedRenamedSyncedPayloadSchema
  );

  if (valid) broadcastToWindows(containerEventChannels.folderRenamed, valid);
}

export function sendFolderSynced(folder: unknown): void {
  const valid = parseOrDrop(
    containerEventChannels.folderSynced,
    folder,
    folderCreatedRenamedSyncedPayloadSchema
  );

  if (valid) broadcastToWindows(containerEventChannels.folderSynced, valid);
}
