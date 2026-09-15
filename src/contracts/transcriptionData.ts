// Single source of truth for the transcription data/files boundary: the DB
// row projection, the record/audio channels, exports, file selection and the
// pending note navigation. Schema-derived types so main, preload and the
// renderer share one description. Channel names, argument order, results and
// events are unchanged from the previous JS registrations.
import { z } from "zod";

// The SQLite row as database.js projects it (TranscriptionRow). passthrough so
// future columns survive instead of being silently dropped at the bridge.
export const transcriptionItemSchema = z
  .object({
    id: z.number(),
    text: z.string(),
    raw_text: z.string().nullable(),
    timestamp: z.string(),
    created_at: z.string(),
    has_audio: z.number(),
    audio_duration_ms: z.number().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    status: z.string(),
    error_message: z.string().nullable(),
    error_code: z.string().nullable(),
    route_kind: z.string().nullable(),
  })
  .passthrough();
export type TranscriptionItem = z.infer<typeof transcriptionItemSchema>;

export const transcriptionOrNullSchema = transcriptionItemSchema.nullable();

// Binary payloads cross structured clone as ArrayBuffer or a typed array
// (Buffer arrives as Uint8Array). Buffers sent over IPC are views into pooled
// allocations, so consumers slice real ArrayBuffers back out.
export const binaryLikeSchema = z.custom<ArrayBuffer | ArrayBufferView>(
  (value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value),
  { message: "Expected binary audio data" }
);
export type BinaryLike = z.infer<typeof binaryLikeSchema>;

// ---- db-* record channels -------------------------------------------------

export const transcriptionSaveResultSchema = z.object({
  id: z.number(),
  success: z.boolean(),
  transcription: transcriptionItemSchema.nullable(),
});
export type TranscriptionSaveResult = z.infer<typeof transcriptionSaveResultSchema>;

export const transcriptionListSchema = z.array(transcriptionItemSchema);

export const transcriptionClearResultSchema = z.object({
  success: z.boolean(),
  cleared: z.number(),
});

export const transcriptionDeleteResultSchema = z
  .object({
    success: z.boolean(),
    id: z.number().optional(),
  })
  .passthrough();
export type TranscriptionDeleteResult = z.infer<typeof transcriptionDeleteResultSchema>;

export const transcriptionUpdateResultSchema = z.object({
  success: z.boolean(),
  transcription: transcriptionItemSchema.nullable().optional(),
  error: z.string().optional(),
});
export type TranscriptionUpdateResult = z.infer<typeof transcriptionUpdateResultSchema>;

// ---- audio storage channels -----------------------------------------------

export const audioSaveResultSchema = z.object({
  success: z.boolean(),
  path: z.string().optional(),
});

export const audioMetadataSchema = z
  .object({
    durationMs: z.number().nullable().optional(),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
  })
  .optional();

export const mergeAudioSegmentsArgsSchema = z.object({
  segments: z
    .array(
      z.object({
        buffer: binaryLikeSchema,
        mimeType: z.string(),
      })
    )
    .min(2)
    .max(100),
});
export type MergeAudioSegmentsArgs = z.infer<typeof mergeAudioSegmentsArgsSchema>;

export const mergeAudioSegmentsResultSchema = z.union([
  z.object({
    success: z.literal(true),
    buffer: binaryLikeSchema,
    mimeType: z.literal("audio/webm"),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

export const audioStorageUsageSchema = z.object({
  fileCount: z.number(),
  totalBytes: z.number(),
});

export const audioDeleteAllResultSchema = z.object({
  deleted: z.number(),
});

// ---- exports ---------------------------------------------------------------

export const exportResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export type ExportResult = z.infer<typeof exportResultSchema>;

export const noteExportFormatSchema = z.enum(["txt", "md"]);
export const transcriptExportFormatSchema = z.enum(["txt", "srt", "json", "md"]);

// ---- file selection --------------------------------------------------------

export const selectAudioFileOptionsSchema = z
  .object({
    multiple: z.boolean().optional(),
  })
  .optional();

export const selectAudioFileResultSchema = z.union([
  z.object({ canceled: z.literal(true) }),
  z.object({
    canceled: z.literal(false),
    filePath: z.string().optional(),
    filePaths: z.array(z.string()).optional(),
  }),
]);

// ---- pending note navigation ----------------------------------------------

export const pendingNoteNavigationSchema = z
  .object({
    noteId: z.number(),
    folderId: z.number().nullable(),
  })
  .passthrough()
  .nullable();
export type PendingNoteNavigation = z.infer<typeof pendingNoteNavigationSchema>;

// ---- main -> renderer events -----------------------------------------------

export const transcriptionAddedEventSchema = transcriptionItemSchema;
export const transcriptionUpdatedEventSchema = transcriptionItemSchema;
export const transcriptionDeletedEventSchema = z.object({ id: z.number() });
export const transcriptionsClearedEventSchema = z.object({ cleared: z.number() });

// ---- channels --------------------------------------------------------------

export const transcriptionDataChannels = {
  saveTranscription: "db-save-transcription",
  getTranscriptions: "db-get-transcriptions",
  clearTranscriptions: "db-clear-transcriptions",
  deleteTranscription: "db-delete-transcription",
  saveTranscriptionAudio: "save-transcription-audio",
  mergeAudioSegments: "merge-audio-segments",
  getAudioPath: "get-audio-path",
  showAudioInFolder: "show-audio-in-folder",
  getAudioBuffer: "get-audio-buffer",
  deleteTranscriptionAudio: "delete-transcription-audio",
  getAudioStorageUsage: "get-audio-storage-usage",
  deleteAllAudio: "delete-all-audio",
  syncRetentionSettings: "retention-settings-changed",
  getTranscriptionById: "get-transcription-by-id",
  updateTranscriptionText: "update-transcription-text",
  exportNote: "export-note",
  exportTranscript: "export-transcript",
  exportDictionary: "export-dictionary",
  selectAudioFile: "select-audio-file",
  approveAudioPath: "approve-audio-path",
  getFileSize: "get-file-size",
  agentOpenNote: "agent-open-note",
  getPendingNoteNavigation: "get-pending-note-navigation",
} as const;

export const transcriptionDataEventChannels = {
  transcriptionAdded: "transcription-added",
  transcriptionUpdated: "transcription-updated",
  transcriptionDeleted: "transcription-deleted",
  transcriptionsCleared: "transcriptions-cleared",
} as const;

// ---- renderer-facing surface ------------------------------------------------

export interface TranscriptionDataApi {
  saveTranscription(
    text: string,
    rawText?: string | null,
    options?: {
      status?: string;
      errorMessage?: string | null;
      errorCode?: string | null;
      clientTranscriptionId?: string;
      analyticsOccurredAt?: string;
      [key: string]: unknown;
    }
  ): Promise<TranscriptionSaveResult>;
  getTranscriptions(limit?: number, options?: { includeDiscarded?: boolean }): Promise<
    TranscriptionItem[]
  >;
  clearTranscriptions(): Promise<{ success: boolean; cleared: number }>;
  deleteTranscription(id: number): Promise<TranscriptionDeleteResult>;
  saveTranscriptionAudio(
    id: number,
    audioBuffer: ArrayBuffer,
    metadata?: { durationMs?: number; provider?: string; model?: string }
  ): Promise<{ success: boolean; path?: string }>;
  mergeAudioSegments(
    segments: Array<{ buffer: ArrayBuffer; mimeType: string }>
  ): Promise<
    | { success: true; buffer: ArrayBuffer; mimeType: "audio/webm" }
    | { success: false; error: string }
  >;
  getAudioPath(id: number): Promise<string | null>;
  showAudioInFolder(id: number): Promise<{ success: boolean }>;
  getAudioBuffer(id: number): Promise<ArrayBuffer | null>;
  deleteTranscriptionAudio(id: number): Promise<{ success: boolean }>;
  getAudioStorageUsage(): Promise<{ fileCount: number; totalBytes: number }>;
  deleteAllAudio(): Promise<{ deleted: number }>;
  syncRetentionSettings?(settings: {
    audioRetentionDays: number;
    transcriptRetentionDays: number;
    dataRetentionEnabled: boolean;
    localHistoryPolicyResolved: boolean;
  }): void;
  getTranscriptionById(id: number): Promise<TranscriptionItem | null>;
  updateTranscriptionText(
    id: number,
    text: string,
    rawText: string
  ): Promise<TranscriptionUpdateResult>;
  exportNote(noteId: number, format: "txt" | "md"): Promise<ExportResult>;
  exportTranscript(noteId: number, format: "txt" | "srt" | "json" | "md"): Promise<ExportResult>;
  exportDictionary(words: string[]): Promise<ExportResult>;
  selectAudioFile(options?: { multiple?: boolean }): Promise<{
    canceled: boolean;
    filePath?: string;
    filePaths?: string[];
  }>;
  getFileSize?(filePath: string): Promise<number>;
  getPendingNoteNavigation?(): Promise<PendingNoteNavigation>;
  onTranscriptionAdded?(callback: (item: TranscriptionItem) => void): () => void;
  onTranscriptionUpdated?(callback: (item: TranscriptionItem) => void): () => void;
  onTranscriptionDeleted?(callback: (payload: { id: number }) => void): () => void;
  onTranscriptionsCleared?(callback: (payload: { cleared: number }) => void): () => void;
}
