// Single source of truth for the local file transcription boundary: the
// options the renderer may pass, the response shape the managers actually
// produce, and the one renderer IPC channel. Schema-derived types, so main,
// preload and the shared execution module share one description.
//
// The response is deliberately tolerant: whisper reports silence as
// { success:false, message } without an error, the sherpa stack reports
// code/message or warning, and the IPC path layer adds error strings. The
// schema keeps message/warning instead of collapsing everything into a
// narrow { success, text, error }.
import { z } from "zod";
import type { LocalTranscriptionProvider } from "./inferenceSettings.js";

// Options cross the boundary as a plain object spread. provider/model/
// language/requestId are the documented fields; skipDecoderThresholds is the
// one whisper-server extension field the executors read.
export const transcriptionOptionsSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  language: z.string().optional(),
  requestId: z.string().optional(),
  skipDecoderThresholds: z.boolean().optional(),
});

export type TranscriptionOptions = z.infer<typeof transcriptionOptionsSchema>;

export const transcriptionResponseSchema = z.object({
  success: z.boolean(),
  text: z.string().optional(),
  // Manager-reported failure detail without an error code (whisper
  // no-audio, sherpa no-speech) or a human supplement to error.
  message: z.string().optional(),
  // Sherpa partial-transcription warning surfaced as a toast.
  warning: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

export type TranscriptionResponse = z.infer<typeof transcriptionResponseSchema>;

// The renderer-facing surface: one operation. AbortSignal is a Node-side
// execution dependency injected by the handler — never part of this API.
export interface LocalFileTranscriptionApi {
  transcribeAudioFile(
    filePath: string,
    options?: {
      provider?: LocalTranscriptionProvider;
      model?: string;
      language?: string;
      requestId?: string;
      skipDecoderThresholds?: boolean;
    }
  ): Promise<TranscriptionResponse>;
}

export const localFileTranscriptionChannels = {
  transcribeAudioFile: "transcribe-audio-file",
} as const;
