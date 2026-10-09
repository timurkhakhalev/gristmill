// Speaker/profile/diarization-model IPC, moved out of ipcHandlers.js behind
// the shared speakerProfiles contract: contact lookup, speaker mappings and
// profiles (public DTO only — the DB embedding Buffer never crosses), note
// speaker embeddings, and the diarization model lifecycle with progress
// forwarded to the requesting window. Semantics are the pre-cutover ones 1:1.
import {
  speakerChannels,
  type DiarizationDownloadProgressEvent,
} from "../contracts/speakerProfiles.js";
import { z } from "zod";
import type { SpeakerMappingRow, SpeakerProfileWithEmbedding } from "./database.js";

type IpcMainLike = {
  handle<Result>(channel: string, listener: (...args: unknown[]) => Result): void;
};

// Renderer arguments arrive untyped; these tuple schemas pin the exact shapes
// the channels have always accepted before any database call.
const searchContactsArgs = z.tuple([z.string()]);

const upsertContactArgs = z.tuple([
  z.object({ email: z.string(), displayName: z.string().nullish() }),
]);

const renameContactArgs = z.tuple([z.string().min(1), z.string().nullable()]);

const noteIdArgs = z.tuple([z.number()]);

const setSpeakerMappingArgs = z.tuple([
  z.number(),
  z.string(),
  z.string(),
  z.string().nullish(),
  z.number().nullish(),
]);

const removeSpeakerMappingArgs = z.tuple([z.number(), z.string()]);

const attachSpeakerEmailArgs = z.tuple([z.number(), z.string().nullable()]);

const saveNoteSpeakerEmbeddingsArgs = z.tuple([
  z.number(),
  z.record(z.string(), z.array(z.number())).optional(),
]);

function messageOf<T>(error: T): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function isCodedError<T>(value: T): value is T & { code: string } {
  return value instanceof Error && "code" in value && typeof value.code === "string";
}

function codeOf<T>(error: T): string | undefined {
  return isCodedError(error) ? error.code : undefined;
}

interface RequestingSender {
  isDestroyed(): boolean;
  send(channel: string, payload: DiarizationDownloadProgressEvent): void;
}

interface RequestEvent {
  sender: RequestingSender;
}

// Narrow DB surface this registration consumes (database.ts satisfies it).
export interface SpeakerDatabase {
  searchContacts(query: string): Array<{ email: string; display_name: string | null }>;
  upsertContacts(contacts: Array<{ email?: string; displayName?: string | null }>): void;
  setContactName(email: string, name: string | null): void;
  getContactProfiles(
    emails: string[]
  ): Array<{ email: string; display_name: string | null; photo_url: string | null }>;
  upsertSpeakerProfile(
    displayName: string,
    email: string | null,
    embedding: Buffer,
    profileId: number | null
  ): SpeakerProfileWithEmbedding | null;
  getSpeakerMappings(noteId: number): SpeakerMappingRow[];
  getNoteSpeakerEmbeddings(noteId: number): Array<{ speaker_id: string; embedding: Buffer }>;
  setSpeakerMapping(
    noteId: number,
    speakerId: string,
    profileId: number | null,
    displayName: string
  ): void;
  removeSpeakerMapping(noteId: number, speakerId: string): void;
  getSpeakerProfiles(): Array<{
    id: number;
    display_name: string;
    email: string | null;
    sample_count: number;
    created_at?: string;
    updated_at?: string;
  }>;
  attachEmailToProfile(profileId: number, email: string | null): SpeakerProfileWithEmbedding | null;
  saveNoteSpeakerEmbeddings(
    noteId: number,
    embeddings: Array<{ speakerId: string; embedding: Buffer }>
  ): void;
}

// Narrow diarization-manager surface.
export interface DiarizationModelsLike {
  downloadModels(
    progressCallback: (data: DiarizationDownloadProgressEvent) => void
  ): Promise<{ success: boolean; path: string }>;
  isAvailable(): boolean;
  isModelDownloaded(): boolean;
  isVadModelDownloaded(): boolean;
  deleteModels(): Promise<{ success?: boolean }>;
  cancelDownload(): Promise<{ success: boolean; message?: string; error?: string }>;
}

export interface SpeakerIpcDeps {
  databaseManager: SpeakerDatabase;
  diarizationManager: DiarizationModelsLike;
  // Retroactive/auto-label propagation owned by the orchestrating IPC class.
  retroactiveMapping(profile: SpeakerProfileWithEmbedding): void;
  tryAutoLabelOneOnOne(noteId: number): void;
  logError<T>(message: string, data?: T): void;
}

export function registerSpeakerHandlers(ipcMain: IpcMainLike, deps: SpeakerIpcDeps): void {
  const c = speakerChannels;

  ipcMain.handle(c.searchContacts, async (_event, ...args: unknown[]) => {
    try {
      const [query] = searchContactsArgs.parse(args);
      const contacts = deps.databaseManager.searchContacts(query);

      return { success: true, contacts };
    } catch {
      return { success: false, contacts: [] };
    }
  });

  ipcMain.handle(c.getContactProfiles, async (_event, ...args: unknown[]) => {
    const emails = Array.isArray(args[0])
      ? args[0].filter((email): email is string => typeof email === "string")
      : [];

    try {
      return deps.databaseManager.getContactProfiles(emails.slice(0, 500));
    } catch {
      return [];
    }
  });

  ipcMain.handle(c.upsertContact, async (_event, ...args: unknown[]) => {
    try {
      const [contact] = upsertContactArgs.parse(args);

      deps.databaseManager.upsertContacts([contact]);

      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(c.renameContact, async (_event, ...args: unknown[]) => {
    try {
      const [email, name] = renameContactArgs.parse(args);

      deps.databaseManager.setContactName(email, name);

      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(c.getSpeakerMappings, async (_event, ...args: unknown[]) => {
    const [noteId] = noteIdArgs.parse(args);

    return deps.databaseManager.getSpeakerMappings(noteId);
  });

  ipcMain.handle(
    c.setSpeakerMapping,
    async (_event, ...args: unknown[]): Promise<{ success: boolean; profileId: number | null }> => {
      const [noteId, speakerId, displayName, email, profileId] = setSpeakerMappingArgs.parse(args);

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
    const [noteId, speakerId] = removeSpeakerMappingArgs.parse(args);

    deps.databaseManager.removeSpeakerMapping(noteId, speakerId);

    return { success: true };
  });

  ipcMain.handle(c.getSpeakerProfiles, async () => {
    return deps.databaseManager.getSpeakerProfiles();
  });

  ipcMain.handle(c.attachSpeakerEmail, async (_event, ...args: unknown[]) => {
    try {
      const [profileId, email] = attachSpeakerEmailArgs.parse(args);
      const profile = deps.databaseManager.attachEmailToProfile(profileId, email);

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
      const message = messageOf(error);

      deps.logError("Failed to attach email to speaker profile", { error: message });

      return { success: false, error: message };
    }
  });

  ipcMain.handle(c.saveNoteSpeakerEmbeddings, async (_event, ...args: unknown[]) => {
    const [noteId, embeddingsObj] = saveNoteSpeakerEmbeddingsArgs.parse(args);

    const embeddings = Object.entries(embeddingsObj ?? {}).map(([speakerId, arr]) => ({
      speakerId,
      embedding: Buffer.from(new Float32Array(arr).buffer),
    }));

    deps.databaseManager.saveNoteSpeakerEmbeddings(noteId, embeddings);
    deps.tryAutoLabelOneOnOne(noteId);

    return { success: true };
  });

  ipcMain.handle(c.downloadDiarizationModels, async (rawEvent) => {
    // SAFETY: Electron invokes handlers with an IpcMainInvokeEvent whose
    // sender provides isDestroyed/send; only those two members are used.
    const event = rawEvent as RequestEvent;

    try {
      const result = await deps.diarizationManager.downloadModels((progressData) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(c.diarizationDownloadProgress, progressData);
        }
      });

      return result;
    } catch (error) {
      const message = messageOf(error);
      const code = codeOf(error);

      if (!event.sender.isDestroyed()) {
        event.sender.send(c.diarizationDownloadProgress, {
          type: "error",
          error: message,
          code: code || "DOWNLOAD_FAILED",
        });
      }

      return {
        success: false,
        error: message,
        code: code || "DOWNLOAD_FAILED",
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
      const message = messageOf(error);

      deps.logError("Failed to delete diarization models", { error: message });

      return { success: false, error: message };
    }
  });

  ipcMain.handle(c.cancelDiarizationDownload, async () => {
    return deps.diarizationManager.cancelDownload();
  });
}
