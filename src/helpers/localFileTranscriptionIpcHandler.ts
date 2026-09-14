// The transcribe-audio-file IPC handler, moved out of ipcHandlers.js.
// Owns the allowed-path check before any read, the requestId registration
// in the shared upload cancel registry, and the translation of exceptions
// into IPC failure shapes. The actual read+dispatch lives in the shared
// localFileTranscription module so the CLI bridge uses the same execution
// path.
import type { ZodType } from "zod";
import {
  transcriptionResponseSchema,
  type TranscriptionResponse,
} from "../contracts/localFileTranscription.js";
import { transcribeLocalFile } from "./localFileTranscription.js";

export interface TranscriptionHandlerDeps {
  readFile: (filePath: string) => Buffer;
  resolveAllowedAudioPath: (filePath: string) => string | null;
  isSherpaLocalProvider: (provider: unknown) => boolean;
  transcribeLocalWhisper: (audioBuffer: Buffer, options: unknown) => unknown;
  transcribeLocalParakeet: (audioBuffer: Buffer, options: unknown) => unknown;
  resolveWhisperVadOptions: (context: string) => unknown;
  // The shared registry instance — one per app, never per request.
  uploadCancelRegistry: {
    register: (requestId: unknown) => { signal: AbortSignal | undefined; release: () => void };
  };
  logDebug: (message: string, data?: unknown) => void;
  logError: (message: string, data?: unknown) => void;
}

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

function parseResponse<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error("Local transcription returned an unexpected result shape");
  }
  return result.data;
}

export function registerLocalFileTranscriptionHandler(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: TranscriptionHandlerDeps
): void {
  ipcMain.handle(
    "transcribe-audio-file",
    async (_event, ...args: unknown[]): Promise<TranscriptionResponse> => {
      const filePath = args[0];
      // The old JS default (`options = {}`) applied only to undefined; an
      // explicit null reached options.requestId and threw before any read —
      // keep rejecting it instead of accepting it as an empty config.
      const options = args[1] === undefined ? {} : (args[1] as Record<string, unknown>);
      // Uploads pass a requestId so cancel-upload-transcription can abort the
      // local decode; flows without one (voice drafts) register nothing.
      const { signal, release } = deps.uploadCancelRegistry.register(options.requestId);
      try {
        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const real = deps.resolveAllowedAudioPath(filePath);
        if (!real) return { success: false, error: "File path not allowed" };
        return parseResponse(
          transcriptionResponseSchema,
          await transcribeLocalFile(deps, real, { ...options, signal })
        );
      } catch (error) {
        const err = error as { name?: string; message?: string };
        if (err?.name === "AbortError" || signal?.aborted) {
          deps.logDebug("Local audio file transcription cancelled", {
            requestId: options.requestId,
          });
          return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
        }
        deps.logError("Audio file transcription error", { error: err?.message });
        return { success: false, error: err?.message ?? "Transcription failed" };
      } finally {
        release();
      }
    }
  );
}
