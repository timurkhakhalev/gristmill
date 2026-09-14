// Shared local file transcription execution, extracted from
// IPCHandlers.transcribeLocalFile. Reads the file and dispatches to the
// existing Whisper/Sherpa managers — the managers, VAD resolver and approved
// path registry keep owning their logic. Both the IPC handler and the CLI
// bridge call into this one module; there is no second implementation.
import type { ZodType } from "zod";
import {
  transcriptionResponseSchema,
  type TranscriptionResponse,
} from "../contracts/localFileTranscription.js";

export interface LocalTranscriptionDeps {
  readFile: (filePath: string) => Buffer;
  isSherpaLocalProvider: (provider: unknown) => boolean;
  transcribeLocalWhisper: (audioBuffer: Buffer, options: unknown) => unknown;
  transcribeLocalParakeet: (audioBuffer: Buffer, options: unknown) => unknown;
  resolveWhisperVadOptions: (context: string) => unknown;
}

export type { TranscriptionResponse };

function parseResponse<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error("Local transcription returned an unexpected result shape");
  }
  return result.data;
}

// `filePath` must already have passed path validation (resolveAllowedAudioPath
// or approveAudioPath). Options pass through as-is; whisper additionally
// receives the noteRecording VAD resolution, sherpa receives the signal.
export async function transcribeLocalFile(
  deps: LocalTranscriptionDeps,
  filePath: string,
  options: Record<string, unknown> = {}
): Promise<TranscriptionResponse> {
  const audioBuffer = deps.readFile(filePath);
  if (deps.isSherpaLocalProvider(options.provider)) {
    return parseResponse(
      transcriptionResponseSchema,
      await deps.transcribeLocalParakeet(audioBuffer, options)
    );
  }
  const vad = deps.resolveWhisperVadOptions("noteRecording") as Record<string, unknown>;
  return parseResponse(
    transcriptionResponseSchema,
    await deps.transcribeLocalWhisper(audioBuffer, { ...options, ...vad })
  );
}
