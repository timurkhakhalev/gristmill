// The cancel-upload-transcription IPC handler: the explicit hard cancel of
// one managed upload execution. Aborts every operation (transcription,
// diarization, transport) registered under the requestId in the one app-scoped
// registry. Unknown, repeated or late ids are a safe no-op — the renderer
// fires a cancel for every provider, including ones that never register.
import {
  uploadCancelRequestSchema,
  uploadTranscriptionChannels,
} from "../contracts/uploadTranscription.js";
import type { UploadCancelRegistry } from "./uploadCancelRegistry.js";

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

export function registerUploadCancelHandler(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: { uploadCancelRegistry: UploadCancelRegistry }
): void {
  ipcMain.handle(
    uploadTranscriptionChannels.cancelUploadTranscription,
    async (_event, ...args: unknown[]) => {
      const parsed = uploadCancelRequestSchema.safeParse(args[0]);

      if (!parsed.success) {
        return { success: false, error: "Invalid cancel request" };
      }

      const cancelled = deps.uploadCancelRegistry.cancel(parsed.data.requestId);

      return { success: true, cancelled };
    }
  );
}
