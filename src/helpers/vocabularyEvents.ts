// The single sender for the two vocabulary events. Every producer — the typed
// handlers in vocabularyIpcHandlers.ts and the CLI bridge — goes through here
// so a malformed payload from JS-land is dropped and diagnosed instead of
// reaching renderers. A bad payload must never break the already-completed DB
// operation or the remaining side effects, so a validation failure only logs.
import { broadcastToWindows } from "./windowBroadcast.js";
import {
  dictionaryWordsSchema,
  snippetSchema,
  vocabularyEventChannels,
} from "../contracts/vocabulary.js";
import { z } from "zod";
import type { ZodType } from "zod";

const snippetListSchema = z.array(snippetSchema);

function parseOrDrop<T>(channel: string, payload: unknown, schema: ZodType<T>): T | null {
  const result = schema.safeParse(payload);

  if (!result.success) {
    console.error(
      `[vocabularyEvents] dropped malformed ${channel} payload: ${result.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );

    return null;
  }

  return result.data;
}

export function sendDictionaryUpdated(words: unknown): void {
  const valid = parseOrDrop(
    vocabularyEventChannels.dictionaryUpdated,
    words,
    dictionaryWordsSchema
  );

  if (valid) broadcastToWindows(vocabularyEventChannels.dictionaryUpdated, valid);
}

export function sendSnippetsUpdated(snippets: unknown): void {
  const valid = parseOrDrop(vocabularyEventChannels.snippetsUpdated, snippets, snippetListSchema);

  if (valid) broadcastToWindows(vocabularyEventChannels.snippetsUpdated, valid);
}
