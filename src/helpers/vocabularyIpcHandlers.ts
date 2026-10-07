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

// The manager-side result shapes these handlers read before validating the
// wire subset. `error` is optional: applyDictionaryChanges may report one.
export interface SuccessDbResult {
  success: boolean;
  error?: string;
}

export interface DictionaryChangeDbResult {
  success: boolean;
  added: number;
  removed: number;
  error?: string;
}

export interface VocabularySnippetInput {
  trigger: string;
  replacement: string;
}

export interface VocabularyDatabase {
  getDictionary(): string[];
  setDictionary(words: unknown[]): SuccessDbResult;
  applyDictionaryChanges(changes: { add?: unknown; remove?: unknown }): DictionaryChangeDbResult;
  hardDeleteDictionaryEntry(id: number | string | null): SuccessDbResult;
  getSnippets(): Array<{ trigger: string; replacement: string }>;
  setSnippets(snippets: unknown[]): SuccessDbResult;
  hardDeleteSnippet(id: number | string | null): SuccessDbResult;
}

export interface VocabularyHandlerDeps {
  database: VocabularyDatabase;
  debugLogger: { debug: (message: string, context?: VocabularyLogContext) => void };
}

interface VocabularyLogContext {
  error?: unknown;
  words?: string[];
}

// The renderer's `applyDictionaryChanges` patch. Both fields are untrusted
// until each is checked with Array.isArray below.
interface DictionaryDeltaRecord {
  add?: unknown;
  remove?: unknown;
}

function isDeltaRecord<T>(value: T): value is T & DictionaryDeltaRecord {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString<T>(value: T): value is T & string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface IpcMainLike {
  handle<Result>(channel: string, listener: (...args: unknown[]) => Result): void;
}

// Throw before the DB is touched when the renderer sent a wrong-shaped call.
function parseArgs<T, Args>(schema: ZodType<T>, args: Args): T {
  const result = schema.safeParse(args);

  if (!result.success) {
    throw new Error(
      `Invalid arguments for vocabulary channel: ${result.error.issues[0]?.message ?? "unknown"}`
    );
  }

  return result.data;
}

// A wrong-shaped database response must not flow into renderers.
function parseResult<T, Raw>(schema: ZodType<T>, raw: Raw): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error("Unexpected database response shape");
  }

  return result.data;
}

export function registerVocabularyHandlers(
  ipcMain: IpcMainLike,
  deps: VocabularyHandlerDeps
): void {
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
    const { add, remove } = isDeltaRecord(changes) ? changes : {};

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

      const validWords = words.filter(isNonEmptyString);

      if (validWords.length === 0) {
        return { success: false };
      }

      const saveResult = database.applyDictionaryChanges({ remove: validWords });

      if (saveResult.success === false) {
        debugLogger.debug("[AutoLearn] Undo failed to save dictionary", {
          error: saveResult.error,
        });

        return { success: false };
      }

      sendDictionaryUpdated(parseResult(dictionaryWordsSchema, database.getDictionary()));
      debugLogger.debug("[AutoLearn] Undo: removed words", { words: validWords });

      return { success: true };
    } catch (err) {
      debugLogger.debug("[AutoLearn] Undo failed", {
        error: err instanceof Error ? err.message : String(err),
      });

      return { success: false };
    }
  });
}
