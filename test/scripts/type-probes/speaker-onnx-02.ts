// @probe-name "an incomplete database fails the speaker registration"
// @probe-codes [2739,2740,2740]
// @probe-origin test/scripts/speakerOnnxTypeProbe.test.js
import { registerSpeakerHandlers } from "./src/helpers/speakerIpcHandlers.ts";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerSpeakerHandlers(ipcMain, {
  databaseManager: {
    searchContacts: () => [],
  },
  liveSpeakerIdentifier: {},
  diarizationManager: {},
  retroactiveMapping: () => undefined,
  tryAutoLabelOneOnOne: () => undefined,
  logError: () => undefined,
});
