// The ten vocabulary DB channels, moved out of ipcHandlers.js. Registration
// order, positional arguments, return shapes, throws and side effects match
// the previous JS implementations; SQL stays in DatabaseManager. Arguments
// are accepted as unknown, validated with the shared tuple schemas, and only
// validated results/events reach the wire.
import { z } from "zod";
import type { ZodType } from "zod";
import {
  applyDictionaryChangesArgsSchema,
  hardDeleteDictionaryArgsSchema,
  hardDeleteSnippetArgsSchema,
  setDictionaryArgsSchema,
  setSnippetsArgsSchema,
  undoLearnedCorrectionsArgsSchema,
  vocabularyChannels,
  dictionaryChangeResultSchema,
  dictionaryWordsSchema,
  simpleSuccessSchema,
  snippetSchema,
} from "../contracts/vocabulary.js";
import { sendDictionaryUpdated, sendSnippetsUpdated } from "./vocabularyEvents.js";

const snippetListSchema = z.array(snippetSchema);

export interface VocabularyHandlerDeps {
  database: {
    getDictionary: () => unknown;
    setDictionary: (words: unknown) => unknown;
    applyDictionaryChanges: (changes: { add?: unknown; remove?: unknown }) => unknown;
    hardDeleteDictionaryEntry: (id: unknown) => unknown;
    getSnippets: () => unknown;
    setSnippets: (snippets: unknown) => unknown;
    hardDeleteSnippet: (id: unknown) => unknown;
  };
  debugLogger: { debug: (message: string, context?: Record<string, unknown>) => void };
}
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

// Throw before the DB is touched when the renderer sent a wrong-shaped call.
function parseArgs<T>(schema: ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new Error(`Invalid arguments for vocabulary channel: ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  return result.data;
}

// A wrong-shaped database response must not flow into renderers.
function parseResult<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error("Unexpected database response shape");
  }
  return result.data;
}

export function registerVocabularyHandlers(ipcMain: IpcMainLike, deps: VocabularyHandlerDeps): void {
  const { database, debugLogger } = deps;

  ipcMain.handle(vocabularyChannels.getDictionary, async () => {
    return parseResult(dictionaryWordsSchema, database.getDictionary());
  });

  ipcMain.handle(vocabularyChannels.setDictionary, async (_event, ...rawArgs) => {
    const [words] = parseArgs(setDictionaryArgsSchema, rawArgs);
    // Historical JS boundary: the Array.isArray guard throws before the DB.
    if (!Array.isArray(words)) {
      throw new Error("words must be an array");
    }
    return parseResult(simpleSuccessSchema, database.setDictionary(words));
  });

  ipcMain.handle(vocabularyChannels.applyDictionaryChanges, async (_event, ...rawArgs) => {
    const [changes] = parseArgs(applyDictionaryChangesArgsSchema, rawArgs);
    const { add, remove } = (changes ?? {}) as { add?: unknown; remove?: unknown };
    if (add !== undefined && !Array.isArray(add)) {
      throw new Error("add must be an array");
    }
    if (remove !== undefined && !Array.isArray(remove)) {
      throw new Error("remove must be an array");
    }
    return parseResult(
      dictionaryChangeResultSchema,
      database.applyDictionaryChanges({ add, remove })
    );
  });

  ipcMain.handle(vocabularyChannels.hardDeleteDictionary, async (_event, ...rawArgs) => {
    const [id] = parseArgs(hardDeleteDictionaryArgsSchema, rawArgs);
    return parseResult(simpleSuccessSchema, database.hardDeleteDictionaryEntry(id));
  });

  ipcMain.handle(vocabularyChannels.broadcastDictionaryUpdated, async () => {
    // Emit the normalized list straight from SQLite so renderers see the
    // post-dedupe truth, never a caller-supplied payload.
    const words = parseResult(dictionaryWordsSchema, database.getDictionary());
    sendDictionaryUpdated(words);
    return { success: true };
  });

  ipcMain.handle(vocabularyChannels.getSnippets, async () => {
    return parseResult(snippetListSchema, database.getSnippets());
  });

  ipcMain.handle(vocabularyChannels.setSnippets, async (_event, ...rawArgs) => {
    const [snippets] = parseArgs(setSnippetsArgsSchema, rawArgs);
    if (!Array.isArray(snippets)) {
      throw new Error("snippets must be an array");
    }
    return parseResult(simpleSuccessSchema, database.setSnippets(snippets));
  });

  ipcMain.handle(vocabularyChannels.hardDeleteSnippet, async (_event, ...rawArgs) => {
    const [id] = parseArgs(hardDeleteSnippetArgsSchema, rawArgs);
    return parseResult(simpleSuccessSchema, database.hardDeleteSnippet(id));
  });

  ipcMain.handle(vocabularyChannels.broadcastSnippetsUpdated, async () => {
    const snippets = parseResult(snippetListSchema, database.getSnippets());
    sendSnippetsUpdated(snippets);
    return { success: true };
  });

  ipcMain.handle(vocabularyChannels.undoLearnedCorrections, async (_event, ...rawArgs) => {
    const [words] = parseArgs(undoLearnedCorrectionsArgsSchema, rawArgs);
    try {
      if (!Array.isArray(words) || words.length === 0) {
        return { success: false };
      }
      const validWords = words.filter((w) => typeof w === "string" && w.trim().length > 0);
      if (validWords.length === 0) {
        return { success: false };
      }
      const saveResult = database.applyDictionaryChanges({ remove: validWords });
      if ((saveResult as { success?: boolean } | undefined)?.success === false) {
        debugLogger.debug("[AutoLearn] Undo failed to save dictionary", {
          error: (saveResult as { error?: unknown }).error,
        });
        return { success: false };
      }
      sendDictionaryUpdated(parseResult(dictionaryWordsSchema, database.getDictionary()));
      debugLogger.debug("[AutoLearn] Undo: removed words", { words: validWords });
      return { success: true };
    } catch (err) {
      debugLogger.debug("[AutoLearn] Undo failed", { error: (err as Error).message });
      return { success: false };
    }
  });
}

import {
  dictionaryChangeResultSchema as _dictionaryChangeResultSchema,
} from "../contracts/vocabulary.js";

