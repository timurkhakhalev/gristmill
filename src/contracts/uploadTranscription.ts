// Single source of truth for the managed audio-upload execution boundary:
// remote (BYOK/self-hosted) file transcription, file diarization, the
// speaker-text merge and the explicit cancel of one upload execution.
// Schema-derived types, so main handlers, the bundled preload and the renderer
// share one description of channel names and wire shapes.
//
// Operations of one managed upload share a requestId; the app-scoped upload
// cancel registry aborts every operation registered under that id. Calls
// without managed cancellation (voice drafts, plain transcribeFile) may omit
// the id entirely — a present id must be non-empty.
import { z } from "zod";

const nonEmptyRequestId = z.string().min(1);

// --- Remote transcription (transcribe-audio-file-byok) ----------------------

// Fields keep their per-operation applicability: file-oriented transcription
// consumes filePath/route settings; merge and cancel never see this shape.
// Unknown keys are dropped before any path resolution, read or network call.
export const remoteTranscriptionRequestSchema = z.object({
  filePath: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  diarize: z.boolean().optional(),
  multichannel: z.boolean().optional(),
  timestamps: z.boolean().optional(),
  provider: z.string().optional(),
  language: z.string().optional(),
  environment: z.string().optional(),
  tenant: z.string().optional(),
  transcriptionMode: z.string().optional(),
  remoteTranscriptionUrl: z.string().optional(),
  remoteTranscriptionModel: z.string().optional(),
  requestId: nonEmptyRequestId.optional(),
});

export type RemoteTranscriptionRequest = z.infer<typeof remoteTranscriptionRequestSchema>;

const transcriptionSegmentSchema = z.object({
  speaker: z.string().optional(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
});

export const remoteTranscriptionResponseSchema = z.object({
  success: z.boolean(),
  text: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  messageKey: z.string().optional(),
  diarized: z.boolean().optional(),
  segments: z.array(transcriptionSegmentSchema).optional(),
});

export type RemoteTranscriptionResult = z.infer<typeof remoteTranscriptionResponseSchema>;

// --- File diarization (diarize-audio-file) ----------------------------------

export const diarizationOptionsSchema = z.object({
  numSpeakers: z.number().optional(),
  threshold: z.number().optional(),
  requestId: nonEmptyRequestId.optional(),
});

export type DiarizationOptions = z.infer<typeof diarizationOptionsSchema>;

export const diarizationSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  speaker: z.string(),
});

export type DiarizationSegment = z.infer<typeof diarizationSegmentSchema>;

export const diarizationResponseSchema = z.object({
  success: z.boolean(),
  segments: z.array(diarizationSegmentSchema).optional(),
  durationSeconds: z.number().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

export type DiarizationResult = z.infer<typeof diarizationResponseSchema>;

// --- Speaker-text merge (merge-speaker-text) --------------------------------
//
// The handler keeps its historical normalizing behavior (sanitized segments,
// size limits reported as error results), so the request schema only pins the
// envelope; junk items are coerced exactly like before.
export const mergeSpeakerTextRequestSchema = z.object({
  segments: z.array(z.unknown()),
  text: z.string(),
  duration: z.number(),
});

export type MergeSpeakerTextRequest = z.infer<typeof mergeSpeakerTextRequestSchema>;

export const mergeSpeakerTextResponseSchema = z.object({
  success: z.boolean(),
  text: z.string().optional(),
  error: z.string().optional(),
});

export type MergeSpeakerTextResult = z.infer<typeof mergeSpeakerTextResponseSchema>;

// --- Upload cancel (cancel-upload-transcription) ----------------------------

export const uploadCancelRequestSchema = z.object({
  requestId: nonEmptyRequestId,
});

export type UploadCancelRequest = z.infer<typeof uploadCancelRequestSchema>;

export const uploadCancelResponseSchema = z.object({
  success: z.boolean(),
  cancelled: z.number().optional(),
  error: z.string().optional(),
});

export type UploadCancelResult = z.infer<typeof uploadCancelResponseSchema>;

// --- Channels and renderer-facing API ---------------------------------------

export const uploadTranscriptionChannels = {
  transcribeAudioFileByok: "transcribe-audio-file-byok",
  diarizeAudioFile: "diarize-audio-file",
  mergeSpeakerText: "merge-speaker-text",
  cancelUploadTranscription: "cancel-upload-transcription",
} as const;

// The renderer-facing surface. AbortSignal is a main-side execution dependency
// resolved from the requestId via the shared registry — never part of this API.
export interface UploadTranscriptionApi {
  transcribeAudioFileByok(request: RemoteTranscriptionRequest): Promise<RemoteTranscriptionResult>;
  diarizeAudioFile(filePath: string, options?: DiarizationOptions): Promise<DiarizationResult>;
  mergeSpeakerText(
    segments: Array<{ start: number; end: number; speaker: string }>,
    text: string,
    duration: number
  ): Promise<MergeSpeakerTextResult>;
  cancelUploadTranscription(request: UploadCancelRequest): Promise<UploadCancelResult>;
}
