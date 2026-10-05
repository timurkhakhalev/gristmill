// Shared local file transcription execution, extracted from
// IPCHandlers.transcribeLocalFile. Reads the file and dispatches to the
// existing Whisper/Sherpa managers — the managers, VAD resolver and approved
// path registry keep owning their logic. Both the IPC handler and the CLI
// bridge call into this one module; there is no second implementation.
import type { ZodType } from "zod";
import {
  transcriptionResponseSchema,
  type TranscriptionOptions,
  type TranscriptionResponse,
} from "../contracts/localFileTranscription.js";

export interface LocalTranscriptionDeps {
  readFile: (filePath: string) => Buffer;
  isSherpaLocalProvider: (provider: unknown) => boolean;
  transcribeLocalWhisper: (audioBuffer: Buffer, options: TranscriptionOptions) => unknown;
  // The sherpa manager reads the cancel signal off the options record.
  transcribeLocalParakeet: (
    audioBuffer: Buffer,
    options: TranscriptionOptions & { signal?: AbortSignal }
  ) => unknown;
  resolveWhisperVadOptions: (context: string) => {
    vadEnabled: boolean;
    vadConfig: Record<string, number>;
  };
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
  options: TranscriptionOptions = {},
  // Main-side cancellation attached by the handler; never a renderer option.
  signal?: AbortSignal
): Promise<TranscriptionResponse> {
  const audioBuffer = deps.readFile(filePath);

  if (deps.isSherpaLocalProvider(options.provider)) {
    return parseResponse(
      transcriptionResponseSchema,
      await deps.transcribeLocalParakeet(audioBuffer, { ...options, signal })
    );
  }

  const { vadEnabled, vadConfig } = deps.resolveWhisperVadOptions("noteRecording");

  return parseResponse(
    transcriptionResponseSchema,
    await deps.transcribeLocalWhisper(audioBuffer, {
      ...options,
      signal,
      // The whisper-server VAD resolver reads vadEnabled plus its numeric
      // config keys off this record (pre-cutover wire shape).
      vadEnabled,
      ...vadConfig,
    })
  );
}
