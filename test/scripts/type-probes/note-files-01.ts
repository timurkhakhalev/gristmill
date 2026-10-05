// @probe-name "wrong note-files and CLI usage fails compilation"
// @probe-codes [2339,2339,2345,2345,2345,2353]
// @probe-origin test/scripts/noteFilesTypeProbe.test.js
import { createNoteFilesBridge } from "./src/preload/noteFilesBridge.ts";
import { registerNoteFilesHandlers } from "./src/helpers/noteFilesIpcHandlers.ts";
import { CliBridge } from "./src/helpers/cliBridge.ts";
import { granolaPreviewResultSchema } from "./src/contracts/noteFiles.ts";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};
const bridge = createNoteFilesBridge(ipcRendererLike);

// setEnabled takes a boolean, not a string.
bridge.noteFilesSetEnabled("yes");

// Reveal takes a numeric note id.
bridge.showNoteFile("12");

// The CLI bridge takes the narrow operations object, not the whole
// IPCHandlers instance.
new CliBridge({ arbitrary: true }, "/tmp");

// Import preview result is a discriminated union: error text is absent on
// the canceled arm.
declare const preview: ReturnType<typeof bridge.granolaImportPickAndPreview>;
async function readCanceled(): Promise<string> {
  const result = await preview;
  if (result.canceled) return result.error;
  return result.fileName;
}
void readCanceled;

// The operations surface requires databaseManager; a mirror-only wiring
// must not compile.
registerNoteFilesHandlers(
  { handle: () => {} },
  { mirror: { init: () => {}, getNotePath: () => null, getFolderPath: () => null } }
);
void granolaPreviewResultSchema;
