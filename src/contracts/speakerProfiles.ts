// Shared wire contract for the speaker boundary: profile/mapping/embedding
// management, contact lookup for speaker attribution, and the diarization
// model lifecycle with its progress event. Renderer shapes mirror the
// database projections exactly — no second projection.
import { z } from "zod";

export const speakerChannels = {
  searchContacts: "search-contacts",
  upsertContact: "upsert-contact",
  renameContact: "rename-contact",
  getContactProfiles: "get-contact-profiles",
  getSpeakerMappings: "get-speaker-mappings",
  setSpeakerMapping: "set-speaker-mapping",
  removeSpeakerMapping: "remove-speaker-mapping",
  getSpeakerProfiles: "get-speaker-profiles",
  attachSpeakerEmail: "attach-speaker-email",
  saveNoteSpeakerEmbeddings: "save-note-speaker-embeddings",
  downloadDiarizationModels: "download-diarization-models",
  getDiarizationModelStatus: "get-diarization-model-status",
  deleteDiarizationModels: "delete-diarization-models",
  cancelDiarizationDownload: "cancel-diarization-download",
  diarizationDownloadProgress: "diarization-download-progress",
} as const;

export const diarizationDownloadProgressEventSchema = z.object({
  type: z.enum(["progress", "complete", "error"]),
  stage: z.string().optional(),
  downloaded_bytes: z.number().optional(),
  total_bytes: z.number().optional(),
  percentage: z.number().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

export type DiarizationDownloadProgressEvent = z.infer<
  typeof diarizationDownloadProgressEventSchema
>;

// Wire rows are schema-derived so every producer/consumer drift fails
// compilation or the parse, not review. The DB embedding Buffer never crosses
// this boundary; contacts/profiles carry only the projected columns.
export const speakerContactSchema = z.object({
  email: z.string(),
  display_name: z.string().nullable(),
});

export type SpeakerContact = z.infer<typeof speakerContactSchema>;

export const contactProfileSchema = z.object({
  email: z.string(),
  display_name: z.string().nullable(),
  photo_url: z.string().nullable(),
});

export type ContactProfile = z.infer<typeof contactProfileSchema>;

export const publicSpeakerProfileSchema = z.object({
  id: z.number(),
  display_name: z.string(),
  email: z.string().nullable(),
  sample_count: z.number(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type PublicSpeakerProfile = z.infer<typeof publicSpeakerProfileSchema>;

export const speakerMappingEntrySchema = z.object({
  note_id: z.number(),
  speaker_id: z.string(),
  profile_id: z.number().nullable(),
  display_name: z.string(),
});

export type SpeakerMappingEntry = z.infer<typeof speakerMappingEntrySchema>;

export const attachSpeakerEmailResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  profile: publicSpeakerProfileSchema
    .pick({ id: true, display_name: true, email: true, sample_count: true })
    .optional(),
});

export type AttachSpeakerEmailResult = z.infer<typeof attachSpeakerEmailResultSchema>;

export const setSpeakerMappingResultSchema = z.object({
  success: z.boolean(),
  profileId: z.number().nullable(),
});

export type SetSpeakerMappingResult = z.infer<typeof setSpeakerMappingResultSchema>;

export const diarizationModelActionResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  code: z.string().optional(),
  path: z.string().optional(),
});

export type DiarizationModelActionResult = z.infer<typeof diarizationModelActionResultSchema>;

export const diarizationModelStatusSchema = z.object({
  available: z.boolean(),
  modelsDownloaded: z.boolean(),
});

export type DiarizationModelStatus = z.infer<typeof diarizationModelStatusSchema>;

export const cancelDiarizationResultSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  error: z.string().optional(),
});

export type CancelDiarizationResult = z.infer<typeof cancelDiarizationResultSchema>;

export interface SpeakerApi {
  searchContacts(query: string): Promise<{ success: boolean; contacts: SpeakerContact[] }>;
  upsertContact(contact: {
    email: string;
    displayName?: string | null;
  }): Promise<{ success: boolean }>;
  /** Sets the name the user chose for a contact; null or blank falls back to Google or invite names. */
  renameContact(email: string, name: string | null): Promise<{ success: boolean }>;
  getContactProfiles(emails: string[]): Promise<ContactProfile[]>;
  getSpeakerMappings(noteId: number): Promise<SpeakerMappingEntry[]>;
  setSpeakerMapping(
    noteId: number,
    speakerId: string,
    displayName: string,
    email?: string | null,
    profileId?: number | null
  ): Promise<SetSpeakerMappingResult>;
  removeSpeakerMapping(noteId: number, speakerId: string): Promise<{ success: boolean }>;
  getSpeakerProfiles(): Promise<PublicSpeakerProfile[]>;
  attachSpeakerEmail(profileId: number, email: string | null): Promise<AttachSpeakerEmailResult>;
  saveNoteSpeakerEmbeddings(
    noteId: number,
    embeddings: Record<string, number[]>
  ): Promise<{ success: boolean }>;
  downloadDiarizationModels(): Promise<DiarizationModelActionResult>;
  getDiarizationModelStatus(): Promise<DiarizationModelStatus>;
  deleteDiarizationModels(): Promise<{ success: boolean; error?: string }>;
  cancelDiarizationDownload(): Promise<CancelDiarizationResult>;
  onDiarizationDownloadProgress(
    callback: (data: DiarizationDownloadProgressEvent) => void
  ): () => void;
}
