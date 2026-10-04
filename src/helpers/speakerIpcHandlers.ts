// Speaker/profile/diarization-model IPC, moved out of ipcHandlers.js behind
// the shared speakerProfiles contract: contact lookup, speaker mappings and
// profiles (public DTO only — the DB embedding Buffer never crosses), note
// speaker embeddings, and the diarization model lifecycle with progress
// forwarded to the requesting window. Semantics are the pre-cutover ones 1:1.
import {
  speakerChannels,
  type DiarizationDownloadProgressEvent,
} from "../contracts/speakerProfiles.js";
import type { SpeakerMappingRow, SpeakerProfileWithEmbedding } from "./database.js";

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

interface RequestingSender {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

interface RequestEvent {
  sender: RequestingSender;
}

// Narrow DB surface this registration consumes (database.ts satisfies it).
export interface SpeakerDatabase {
  searchContacts(query: string): Array<{ email: string; display_name: string | null }>;
  upsertContacts(contacts: Array<{ email?: string; displayName?: string | null }>): unknown;
  getContactProfiles(emails: string[]): Array<{ email: string; display_name: string | null; photo_url: string | null }>;
  upsertSpeakerProfile(
    displayName: string,
    email: string | null,
    embedding: Buffer,
    profileId: number | null
  ): SpeakerProfileWithEmbedding | null;
  getSpeakerMappings(noteId: number): SpeakerMappingRow[];
  getNoteSpeakerEmbeddings(
    noteId: number
  ): Array<{ speaker_id: string; embedding: Buffer }>;
  setSpeakerMapping(
    noteId: number,
    speakerId: string,
    profileId: number | null,
    displayName: string
  ): unknown;
  removeSpeakerMapping(noteId: number, speakerId: string): unknown;
  getSpeakerProfiles(): Array<{
    id: number;
    display_name: string;
    email: string | null;
    sample_count: number;
    created_at?: string;
    updated_at?: string;
  }>;
  attachEmailToProfile(
    profileId: number,
    email: string | null
  ): SpeakerProfileWithEmbedding | null;
  saveNoteSpeakerEmbeddings(
    noteId: number,
    embeddings: Array<{ speakerId: string; embedding: Buffer }>
  ): unknown;
}

// Narrow diarization-manager surface.
export interface DiarizationModelsLike {
  downloadModels(
    progressCallback: (data: DiarizationDownloadProgressEvent) => void
  ): Promise<{ success: boolean; path: string }>;
  isAvailable(): boolean;
  isModelDownloaded(): boolean;
  isVadModelDownloaded(): boolean;
  deleteModels(): Promise<unknown>;
  cancelDownload(): Promise<{ success: boolean; message?: string; error?: string }>;
}

export interface SpeakerIpcDeps {
  databaseManager: SpeakerDatabase;
  diarizationManager: DiarizationModelsLike;
  // Retroactive/auto-label propagation owned by the orchestrating IPC class.
  retroactiveMapping(profile: SpeakerProfileWithEmbedding): void;
  tryAutoLabelOneOnOne(noteId: number): void;
  logError(message: string, data?: unknown): void;
}

export function registerSpeakerHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: SpeakerIpcDeps
): void {
  const c = speakerChannels;

  ipcMain.handle(c.searchContacts, async (_event, ...args: unknown[]) => {
    try {
      const contacts = deps.databaseManager.searchContacts(args[0] as string);
      return { success: true, contacts };
    } catch {
      return { success: false, contacts: [] };
    }
  });

  ipcMain.handle(c.getContactProfiles, async (_event, ...args: unknown[]) => {
    const emails = Array.isArray(args[0]) ? args[0].filter((email): email is string => typeof email === "string") : [];
    try {
      return deps.databaseManager.getContactProfiles(emails.slice(0, 500));
    } catch {
      return [];
    }
  });

  ipcMain.handle(c.upsertContact, async (_event, ...args: unknown[]) => {
    try {
      deps.databaseManager.upsertContacts([args[0] as { email: string; displayName?: string | null }]);
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(c.getSpeakerMappings, async (_event, ...args: unknown[]) => {
    return deps.databaseManager.getSpeakerMappings(args[0] as number);
  });

  ipcMain.handle(
    c.setSpeakerMapping,
    async (_event, ...args: unknown[]): Promise<{ success: boolean; profileId: number | null }> => {
      const noteId = args[0] as number;
      const speakerId = args[1] as string;
      const displayName = args[2] as string;
      const email = args[3] as string | null | undefined;
      const profileId = args[4] as number | null | undefined;

      const database = deps.databaseManager;
      const noteEmbeddings = database.getNoteSpeakerEmbeddings(noteId);
      const noteSpeakerEmbedding = noteEmbeddings.find((e) => e.speaker_id === speakerId);
      const speakerEmbeddingBuffer = noteSpeakerEmbedding?.embedding ?? null;

      let resolvedProfileId = profileId ?? null;
      if (speakerEmbeddingBuffer) {
        const profile = database.upsertSpeakerProfile(
          displayName,
          email || null,
          speakerEmbeddingBuffer,
          resolvedProfileId
        );
        if (profile) {
          resolvedProfileId = profile.id;
          deps.retroactiveMapping(profile);
        }
      }

      database.setSpeakerMapping(noteId, speakerId, resolvedProfileId, displayName);
      return { success: true, profileId: resolvedProfileId };
    }
  );

  ipcMain.handle(c.removeSpeakerMapping, async (_event, ...args: unknown[]) => {
    deps.databaseManager.removeSpeakerMapping(args[0] as number, args[1] as string);
    return { success: true };
  });

  ipcMain.handle(c.getSpeakerProfiles, async () => {
    return deps.databaseManager.getSpeakerProfiles();
  });

  ipcMain.handle(c.attachSpeakerEmail, async (_event, ...args: unknown[]) => {
    try {
      const profile = deps.databaseManager.attachEmailToProfile(
        args[0] as number,
        args[1] as string | null
      );
      if (!profile) {
        return { success: false, error: "Speaker profile not found" };
      }
      deps.retroactiveMapping(profile);
      return {
        success: true,
        profile: {
          id: profile.id,
          display_name: profile.display_name,
          email: profile.email,
          sample_count: profile.sample_count,
        },
      };
    } catch (error) {
      deps.logError(
        "Failed to attach email to speaker profile",
        { error: (error as Error).message },
      );
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(c.saveNoteSpeakerEmbeddings, async (_event, ...args: unknown[]) => {
    const noteId = args[0] as number;
    const embeddingsObj = (args[1] ?? {}) as Record<string, number[]>;
    const embeddings = Object.entries(embeddingsObj).map(([speakerId, arr]) => ({
      speakerId,
      embedding: Buffer.from(new Float32Array(arr).buffer),
    }));
    deps.databaseManager.saveNoteSpeakerEmbeddings(noteId, embeddings);
    deps.tryAutoLabelOneOnOne(noteId);
    return { success: true };
  });

  ipcMain.handle(c.downloadDiarizationModels, async (rawEvent, ...args: unknown[]) => {
    const event = rawEvent as RequestEvent;
    try {
      const result = await deps.diarizationManager.downloadModels(
        (progressData) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(c.diarizationDownloadProgress, progressData);
          }
        }
      );
      return result;
    } catch (error) {
      const err = error as { message?: string; code?: string };
      if (!event.sender.isDestroyed()) {
        event.sender.send(c.diarizationDownloadProgress, {
          type: "error",
          error: err.message,
          code: err.code || "DOWNLOAD_FAILED",
        });
      }
      return {
        success: false,
        error: err.message,
        code: err.code || "DOWNLOAD_FAILED",
      };
    }
  });

  ipcMain.handle(c.getDiarizationModelStatus, async () => {
    return {
      available: deps.diarizationManager?.isAvailable() ?? false,
      modelsDownloaded:
        (deps.diarizationManager?.isModelDownloaded() ?? false) &&
        (deps.diarizationManager?.isVadModelDownloaded() ?? false),
    };
  });

  ipcMain.handle(c.deleteDiarizationModels, async () => {
    try {
      await deps.diarizationManager.deleteModels();
      return { success: true };
    } catch (error) {
      deps.logError("Failed to delete diarization models", { error: (error as Error).message });
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(c.cancelDiarizationDownload, async () => {
    return deps.diarizationManager.cancelDownload();
  });
}
