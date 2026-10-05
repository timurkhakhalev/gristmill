// Renderer-facing vocabulary bridge. Moved out of preload.js so the six
// renderer operations and two subscriptions have one typed implementation
// backed by the shared contract. The sandboxed preload can't require local
// modules, so build-main.js bundles the final preload with esbuild before
// packaging. Main-only channels (hard delete, broadcast pull, undo) stay
// unexposed — they have no renderer consumer.
import {
  dictionaryChangeResultSchema,
  dictionaryWordsSchema,
  simpleSuccessSchema,
  snippetSchema,
  vocabularyChannels,
  vocabularyEventChannels,
  type Snippet,
  type VocabularyApi,
} from "../contracts/vocabulary.js";
import { z } from "zod";
import type { ZodType } from "zod";

const snippetListSchema = z.array(snippetSchema);

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

function subscribeValidated<T>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  schema: ZodType<T>,
  callback: (payload: T) => void
): () => void {
  if (typeof callback !== "function") {
    return () => {};
  }

  const listener = (_event: unknown, data: unknown) => {
    const result = schema.safeParse(data);

    if (!result.success) {
      console.error(`[vocabularyBridge] dropped malformed ${channel} event`);

      return;
    }

    callback(result.data);
  };

  ipcRenderer.on(channel, listener as (event: unknown, ...args: unknown[]) => void);

  return () => {
    ipcRenderer.removeListener(channel, listener as (event: unknown, ...args: unknown[]) => void);
  };
}

// The return type is the shared VocabularyApi, so any drift between this
// implementation and the contract fails compilation instead of review.
export function createVocabularyBridge(ipcRenderer: IpcRendererLike): VocabularyApi {
  return {
    getDictionary: () =>
      ipcRenderer
        .invoke(vocabularyChannels.getDictionary)
        .then((raw) => parseResult(dictionaryWordsSchema, raw, vocabularyChannels.getDictionary)),
    setDictionary: (words: string[]) =>
      ipcRenderer
        .invoke(vocabularyChannels.setDictionary, words)
        .then((raw) => parseResult(simpleSuccessSchema, raw, vocabularyChannels.setDictionary)),
    applyDictionaryChanges: (changes: { add?: string[]; remove?: string[] }) =>
      ipcRenderer
        .invoke(vocabularyChannels.applyDictionaryChanges, changes)
        .then((raw) =>
          parseResult(dictionaryChangeResultSchema, raw, vocabularyChannels.applyDictionaryChanges)
        ),
    onDictionaryUpdated: (callback: (words: string[]) => void) =>
      subscribeValidated(
        ipcRenderer,
        vocabularyEventChannels.dictionaryUpdated,
        dictionaryWordsSchema,
        callback
      ),
    getSnippets: () =>
      ipcRenderer
        .invoke(vocabularyChannels.getSnippets)
        .then((raw) => parseResult(snippetListSchema, raw, vocabularyChannels.getSnippets)),
    setSnippets: (snippets: Snippet[]) =>
      ipcRenderer
        .invoke(vocabularyChannels.setSnippets, snippets)
        .then((raw) => parseResult(simpleSuccessSchema, raw, vocabularyChannels.setSnippets)),
    onSnippetsUpdated: (callback: (snippets: Snippet[]) => void) =>
      subscribeValidated(
        ipcRenderer,
        vocabularyEventChannels.snippetsUpdated,
        snippetListSchema,
        callback
      ),
  };
}
