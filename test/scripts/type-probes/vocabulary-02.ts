// @probe-name "a database with the full contract compiles under strict settings"
// @probe-codes []
// @probe-origin test/scripts/vocabularyTypeProbe.test.js
import { registerVocabularyHandlers } from "./src/helpers/vocabularyIpcHandlers.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

registerVocabularyHandlers(ipcMain, {
  database: {
    getDictionary: () => ["Alpha"],
    setDictionary: (words) => {
      console.log(words);
      return { success: true };
    },
    applyDictionaryChanges: (changes) => {
      console.log(changes);
      return { success: true, added: 1, removed: 0 };
    },
    hardDeleteDictionaryEntry: (id) => {
      console.log(id);
      return { success: true };
    },
    getSnippets: () => [{ trigger: ";em", replacement: "ama" }],
    setSnippets: (snippets) => {
      console.log(snippets);
      return { success: true };
    },
    hardDeleteSnippet: (id) => {
      console.log(id);
      return { success: false };
    },
  },
  debugLogger: { debug() {} },
});
