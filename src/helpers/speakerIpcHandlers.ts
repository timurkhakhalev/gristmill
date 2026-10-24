// Speaker/profile/diarization-model IPC, moved out of ipcHandlers.js behind
// the shared speakerProfiles contract: contact lookup, speaker mappings and
// profiles (public DTO only — the DB embedding Buffer never crosses), note
// speaker embeddings, and the diarization model lifecycle with progress
// forwarded to the requesting window. Contact links use stable local IDs.
import {
  speakerChannels,
  contactCreateInputSchema,
  contactUpdateInputSchema,
  type ContactMutationResult,
  type ContactProfile,
  type SpeakerContact,
  type DiarizationDownloadProgressEvent,
} from "../contracts/speakerProfiles.js";
import { z } from "zod";
import { contactIdSchema } from "../contracts/contactIdentity.js";
import type { SpeakerMappingRow, SpeakerProfileWithEmbedding } from "./database.js";

type IpcMainLike = {
  handle<Result>(channel: string, listener: (...args: unknown[]) => Result): void;
};

// Renderer arguments arrive untyped; these tuple schemas pin the exact shapes
// the channels have always accepted before any database call.
const searchContactsArgs = z.tuple([z.string()]);

const noteIdArgs = z.tuple([z.number()]);

const setSpeakerMappingArgs = z.tuple([
  z.number(),
  z.string(),
  z.string(),
  contactIdSchema.nullish(),
  contactIdSchema.nullish(),
]);

const removeSpeakerMappingArgs = z.tuple([z.number(), z.string()]);

const attachSpeakerContactArgs = z.tuple([contactIdSchema, contactIdSchema.nullable()]);

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
  searchContacts(query: string): SpeakerContact[];
  createContact(input: z.infer<typeof contactCreateInputSchema>): ContactMutationResult;
  updateContact(id: number, input: z.infer<typeof contactUpdateInputSchema>): ContactMutationResult;
  getContactProfiles(ids: number[]): ContactProfile[];
  upsertSpeakerProfile(
    displayName: string,
    contactId: number | null,
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
    contact_id: number | null;
    sample_count: number;
    created_at?: string;
    updated_at?: string;
  }>;
  attachContactToProfile(
    profileId: number,
    contactId: number | null
  ): SpeakerProfileWithEmbedding | null;
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
    const [ids] = z.tuple([contactIdSchema.array().max(500)]).parse(args);

    return deps.databaseManager.getContactProfiles(ids);
  });

  ipcMain.handle(c.createContact, async (_event, ...args: unknown[]) => {
    const [input] = z.tuple([contactCreateInputSchema]).parse(args);

    return deps.databaseManager.createContact(input);
  });

  ipcMain.handle(c.updateContact, async (_event, ...args: unknown[]) => {
    const [id, input] = z.tuple([contactIdSchema, contactUpdateInputSchema]).parse(args);

    return deps.databaseManager.updateContact(id, input);
  });

  ipcMain.handle(c.getSpeakerMappings, async (_event, ...args: unknown[]) => {
    const [noteId] = noteIdArgs.parse(args);

    return deps.databaseManager.getSpeakerMappings(noteId);
  });

  ipcMain.handle(
    c.setSpeakerMapping,
    async (_event, ...args: unknown[]): Promise<{ success: boolean; profileId: number | null }> => {
      const [noteId, speakerId, displayName, contactId, profileId] =
        setSpeakerMappingArgs.parse(args);

      const database = deps.databaseManager;
      const noteEmbeddings = database.getNoteSpeakerEmbeddings(noteId);
      const noteSpeakerEmbedding = noteEmbeddings.find((e) => e.speaker_id === speakerId);
      const speakerEmbeddingBuffer = noteSpeakerEmbedding?.embedding ?? null;

      let resolvedProfileId = profileId ?? null;

      if (speakerEmbeddingBuffer) {
        const profile = database.upsertSpeakerProfile(
          displayName,
          contactId ?? null,
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

  ipcMain.handle(c.attachSpeakerContact, async (_event, ...args: unknown[]) => {
    try {
      const [profileId, contactId] = attachSpeakerContactArgs.parse(args);
      const profile = deps.databaseManager.attachContactToProfile(profileId, contactId);

      if (!profile) {
        return { success: false, error: "Speaker profile not found" };
      }

      deps.retroactiveMapping(profile);

      return {
        success: true,
        profile: {
          id: profile.id,
          display_name: profile.display_name,
          contact_id: profile.contact_id,
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
