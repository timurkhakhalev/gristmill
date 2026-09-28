// Shared wire contract for the speaker boundary: profile/mapping/embedding
// management, contact lookup for speaker attribution, and the diarization
// model lifecycle with its progress event. Renderer shapes mirror the
// database projections exactly — no second projection.
import { z } from "zod";

export const speakerChannels = {
  searchContacts: "search-contacts",
  upsertContact: "upsert-contact",
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
export type DiarizationDownloadProgressEvent = z.infer<typeof diarizationDownloadProgressEventSchema>;

/** The best-known name and photo for an email (Google People first, then calendar or typed names). */
export interface ContactProfile {
  email: string;
  display_name: string | null;
  photo_url: string | null;
}

export interface SpeakerContact {
  email: string;
  display_name: string | null;
  [key: string]: unknown;
}

// Public profile DTO: the internal DB Buffer never crosses this boundary.
export interface PublicSpeakerProfile {
  id: number;
  display_name: string;
  email: string | null;
  sample_count: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface SpeakerMappingEntry {
  note_id: number;
  speaker_id: string;
  profile_id: number | null;
  display_name: string;
  [key: string]: unknown;
}

export interface AttachSpeakerEmailResult {
  success: boolean;
  error?: string;
  profile?: {
    id: number;
    display_name: string;
    email: string | null;
    sample_count: number;
  };
  [key: string]: unknown;
}

export interface SetSpeakerMappingResult {
  success: boolean;
  profileId: number | null;
  [key: string]: unknown;
}

export interface DiarizationModelActionResult {
  success: boolean;
  error?: string;
  code?: string;
  path?: string;
  [key: string]: unknown;
}

export interface DiarizationModelStatus {
  available: boolean;
  modelsDownloaded: boolean;
}

export interface CancelDiarizationResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface SpeakerApi {
  searchContacts(query: string): Promise<{ success: boolean; contacts: SpeakerContact[] }>;
  upsertContact(contact: { email: string; displayName?: string | null }): Promise<{ success: boolean }>;
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
