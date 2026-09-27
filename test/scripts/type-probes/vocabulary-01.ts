// @probe-name "an incomplete database dependency fails compilation"
// @probe-codes [2741]
// @probe-origin test/scripts/vocabularyTypeProbe.test.js
import { registerVocabularyHandlers } from "./src/helpers/vocabularyIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

// A database missing applyDictionaryChanges would let undo report success
// while removing nothing; the compiler must reject the registration.
registerVocabularyHandlers(ipcMain, {
  database: {
    getDictionary: () => ["unchanged"],
    setDictionary: () => ({ success: true }),
    hardDeleteDictionaryEntry: () => ({ success: true }),
    getSnippets: () => [],
    setSnippets: () => ({ success: true }),
    hardDeleteSnippet: () => ({ success: true }),
  },
  debugLogger: { debug() {} },
});
