// Single source of truth for the vocabulary vertical: normalized dictionary
// words, snippets, the ten DB IPC channels and the two broadcast events.
// Everything is derived from Zod schemas so main, preload and renderer share
// one description.
//
// The schemas mirror what DatabaseManager returns from SQLite
// (src/helpers/database.js), not what callers send: the JS database layer
// already normalizes inputs (trims, dedupes, drops junk), so typed public
// inputs stay convenient while the runtime boundary only pins result shapes.
// Raw args are unknown until the handlers validate them.
import { z } from "zod";

export const snippetSchema = z.object({
  trigger: z.string(),
  replacement: z.string(),
});

export type Snippet = z.infer<typeof snippetSchema>;

export const dictionaryWordsSchema = z.array(z.string());

export type DictionaryWords = z.infer<typeof dictionaryWordsSchema>;

export const dictionaryChangeResultSchema = z.object({
  success: z.boolean(),
  added: z.number(),
  removed: z.number(),
});

export const simpleSuccessSchema = z.object({ success: z.boolean() });

const idArg = z.union([z.number(), z.string(), z.null()]);

// Positional arguments and channel names are frozen API: renderer preload and
// main handlers both bind to them. The array arguments stay unknown — the
// handlers preserve the historical Array.isArray throws and the database
// normalizes the entries; tightening them here would delete stored data
// shapes the JS boundary accepted.
export const setDictionaryArgsSchema = z.tuple([z.unknown()]);

export const applyDictionaryChangesArgsSchema = z.tuple([z.unknown().optional()]);

export const hardDeleteDictionaryArgsSchema = z.tuple([idArg]);

export const getSnippetsArgsSchema = z.tuple([]);

export const setSnippetsArgsSchema = z.tuple([z.unknown()]);

export const hardDeleteSnippetArgsSchema = z.tuple([idArg]);

// undo-learned-corrections accepts anything: it filters to non-empty strings
// and fails quietly otherwise.
export const undoLearnedCorrectionsArgsSchema = z.tuple([z.unknown().optional()]);

export const vocabularyChannels = {
  getDictionary: "db-get-dictionary",
  setDictionary: "db-set-dictionary",
  applyDictionaryChanges: "db-apply-dictionary-changes",
  hardDeleteDictionary: "db-hard-delete-dictionary",
  broadcastDictionaryUpdated: "db-broadcast-dictionary-updated",
  getSnippets: "db-get-snippets",
  setSnippets: "db-set-snippets",
  hardDeleteSnippet: "db-hard-delete-snippet",
  broadcastSnippetsUpdated: "db-broadcast-snippets-updated",
  undoLearnedCorrections: "undo-learned-corrections",
} as const;

export const vocabularyEventChannels = {
  dictionaryUpdated: "dictionary-updated",
  snippetsUpdated: "snippets-updated",
} as const;

// Renderer-facing API surface: the methods the preload exposes plus the two
// subscriptions. Main-only channels (hard delete, broadcast pull, undo) have
// no renderer consumer and no bridge method.
export interface VocabularyApi {
  getDictionary(): Promise<string[]>;
  setDictionary(words: string[]): Promise<{ success: boolean }>;
  applyDictionaryChanges(changes: {
    add?: string[];
    remove?: string[];
  }): Promise<{ success: boolean; added: number; removed: number }>;
  onDictionaryUpdated(callback: (words: string[]) => void): () => void;
  getSnippets(): Promise<Snippet[]>;
  setSnippets(snippets: Snippet[]): Promise<{ success: boolean }>;
  onSnippetsUpdated(callback: (snippets: Snippet[]) => void): () => void;
}
