// The single sender for the three Notes events. Every producer — the typed
// editable-Note service, meeting detection, processing and
// deleteNoteInternal — goes through here so a malformed payload from JS-land
// is dropped and diagnosed instead of reaching renderers.
//
// A bad payload must never break the already-completed DB operation or the
// remaining side effects, so a validation failure only logs.
import { broadcastToWindows } from "./windowBroadcast.js";
import {
  noteAddedUpdatedPayloadSchema,
  noteDeletedPayloadSchema,
  noteEventChannels,
} from "../contracts/notes.js";
import type { ZodType } from "zod";

function parseOrDrop<T>(channel: string, payload: unknown, schema: ZodType<T>): T | null {
  const result = schema.safeParse(payload);

  if (!result.success) {
    // Diagnose without echoing note content into logs.
    console.error(
      `[notesEvents] dropped malformed ${channel} payload: ${result.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );

    return null;
  }

  return result.data;
}

export function sendNoteAdded(note: unknown): void {
  const valid = parseOrDrop(noteEventChannels.added, note, noteAddedUpdatedPayloadSchema);

  if (valid) broadcastToWindows(noteEventChannels.added, valid);
}

export function sendNoteUpdated(note: unknown): void {
  const valid = parseOrDrop(noteEventChannels.updated, note, noteAddedUpdatedPayloadSchema);

  if (valid) broadcastToWindows(noteEventChannels.updated, valid);
}

export function sendNoteDeleted(payload: unknown): void {
  const valid = parseOrDrop(noteEventChannels.deleted, payload, noteDeletedPayloadSchema);

  if (valid) broadcastToWindows(noteEventChannels.deleted, valid);
}
