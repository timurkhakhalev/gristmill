// The transcription data/files IPC handlers, moved out of ipcHandlers.js:
// the db-* record channels, audio storage/merge/reveal, retention settings
// sync, note/transcript/dictionary exports, audio file selection/approval/
// size, agent note opening and the pending (non-meeting) note navigation.
// Channels, argument order, results, events and errors are unchanged;
// untrusted payloads are parsed at the boundary and only validated values
// reach the managers.
import { dialog, shell, type WebContents } from "electron";
import fs from "fs";
import { z } from "zod";
import { approveAudioPath, resolveAllowedAudioPath } from "./audioPathAllowlist.js";
import { createRetentionSettingsHandler, type RetentionSettings } from "./retentionSettings.js";
import { mergeAudioSegments } from "./ffmpegUtils.js";
import { serializeDictionaryEntries } from "./dictionaryImport.js";
import {
  formatJson,
  formatMd,
  formatSrt,
  formatTxt,
  type TranscriptExportSegment,
} from "./transcriptFormatter.js";
import {
  binaryLikeSchema,
  transcriptionDataChannels,
  type PendingNoteNavigation,
} from "../contracts/transcriptionData.js";
import type {
  ClearedResult,
  DeletedIdResult,
  NoteRow,
  SuccessResult,
  TranscriptionRow,
  TranscriptionSaveResult,
} from "./database.js";
import type { Logger } from "./transcriptionExecutionIpcHandlers.js";

// The renderer-supplied options bag accepted by db-save-transcription; mirrors
// the manager's own signature so valid calls pass straight through.
interface TranscriptionSaveOptions {
  status?: string;
  errorMessage?: string | null;
  errorCode?: string | null;
  routeKind?: string | null;
  occurredAt?: unknown;
}

interface TranscriptionListOptions {
  includeDiscarded?: boolean;
}

interface TranscriptionAudioUpdate {
  hasAudio: boolean | number;
  audioDurationMs: number | null;
  provider: string | null;
  model: string | null;
}

// The export formats that map to a fixed file extension; anything else falls
// back to "txt" exactly as the previous lookup did.
interface TranscriptExtensions {
  [format: string]: string;
}

export interface TranscriptionDataDeps<PendingNotification = PendingNoteNavigation> {
  // Method syntax keeps parameter checks bivariant so the real
  // DatabaseManager satisfies this without casts; the handler validates
  // untrusted IPC payloads itself before any database call.
  database: {
    saveTranscription(
      text: string,
      rawText: string | null | undefined,
      options: TranscriptionSaveOptions
    ): TranscriptionSaveResult;
    getTranscriptions(limit: number, options: TranscriptionListOptions): TranscriptionRow[];
    clearTranscriptions(): ClearedResult;
    deleteTranscription(id: number): DeletedIdResult;
    updateTranscriptionAudio(id: number, update: TranscriptionAudioUpdate): SuccessResult;
    getTranscriptionById(id: number): TranscriptionRow | null;
    updateTranscriptionText(id: number, text: string, rawText: string | null): SuccessResult;
    getAudioFlaggedIds(): Array<{ id: number }>;
    clearAudioFlags(ids: Array<number | string>): SuccessResult;
    getNote(id: number): NoteRow | null;
  };
  audioStorage: {
    saveAudio: (
      id: number,
      audioBuffer: Buffer,
      timestamp?: string | null
    ) => { success: boolean; path?: string };
    getAudioPath: (id: number) => string | null;
    getAudioBuffer: (id: number) => Buffer | null;
    deleteAudio: (id: number) => { success: boolean };
    getStorageUsage: () => { fileCount: number; totalBytes: number };
    deleteAllAudio: () => { deleted: number; failed: number };
  };
  deleteAllAudio: () => Promise<{ deleted: number; failed: number }>;
  // The shared delete path (audio + row + transcription-deleted broadcast)
  // owned by the composition root.
  deleteTranscriptionInternal: (id: number) => DeletedIdResult;
  buildSpeakerMappings: (noteId: number) => Record<string, string>;
  queueNoteNavigation: (payload: { noteId: number; folderId: number | null }) => Promise<void>;
  consumePendingNoteNavigation: () => PendingNotification;
  retention: {
    getCurrentSettings: () => RetentionSettings;
    getOwner: () => WebContents | null | undefined;
    hasSynced: () => boolean;
    onSettingsChanged: (settings: RetentionSettings) => void;
  };
  broadcast: <Payload>(channel: string, payload: Payload) => void;
  logger: Logger;
}

const SAFE_NAME_PATTERN = /[/\\?%*:|"<>]/g;

// Electron delivers each handler its own event first; the body is only ever a
// rest tuple of renderer arguments, decoded at the boundary before use.
type IpcMainLike = {
  handle<Result>(channel: string, listener: (...args: unknown[]) => Result): void;
  // `event.sender` stays opaque: the only consumer is the retention-settings
  // factory, which compares the sender against the owner window without
  // reading into it.
  on(channel: string, listener: (event: { sender?: unknown }, ...args: unknown[]) => void): void;
};

function messageOf<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

function isSegmentArray<T>(value: T): value is T & unknown[] {
  return Array.isArray(value);
}

const isAudioSegment = <T>(
  value: T
): value is T & { buffer: ArrayBuffer | ArrayBufferView; mimeType: string } => {
  if (typeof value !== "object" || value === null) return false;

  if (!("buffer" in value) || !("mimeType" in value)) return false;
  const buffer: unknown = value.buffer;
  const mimeType: unknown = value.mimeType;

  return (
    (buffer instanceof ArrayBuffer || ArrayBuffer.isView(buffer)) && typeof mimeType === "string"
  );
};

function viewToBuffer(value: ArrayBuffer | ArrayBufferView): Buffer {
  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }

  // SAFETY: IPC binary payloads are structured-cloned ArrayBuffers or typed
  // arrays; a SharedArrayBuffer cannot cross the Electron structured clone
  // boundary, so the backing buffer is always a real ArrayBuffer.
  return Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
}

function formatTxtContent(content: string | null | undefined): string {
  return (content || "")
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/^>\s+/gm, "")
    .trim();
}

export function registerTranscriptionDataHandlers<PendingNotification>(
  ipcMain: IpcMainLike,
  deps: TranscriptionDataDeps<PendingNotification>
): void {
  const { logger, database, audioStorage } = deps;

  ipcMain.handle(
    transcriptionDataChannels.saveTranscription,
    async (_event, ...args: unknown[]) => {
      const [text, rawText, options] = zSaveTranscriptionArgs.parse(args);
      const result = database.saveTranscription(text, rawText, options ?? {});

      if (result?.success && result?.transcription) {
        setImmediate(() => {
          deps.broadcast("transcription-added", result.transcription);
        });
      }

      return result;
    }
  );

  ipcMain.handle(
    transcriptionDataChannels.getTranscriptions,
    async (_event, ...args: unknown[]) => {
      const [limit, options] = zGetTranscriptionsArgs.parse(args);

      return database.getTranscriptions(limit ?? 50, options ?? {});
    }
  );

  ipcMain.handle(transcriptionDataChannels.clearTranscriptions, async () => {
    audioStorage.deleteAllAudio();
    const result = database.clearTranscriptions();

    if (result?.success) {
      setImmediate(() => {
        deps.broadcast("transcriptions-cleared", {
          cleared: result.cleared,
        });
      });
    }

    return result;
  });

  ipcMain.handle(
    transcriptionDataChannels.deleteTranscription,
    async (_event, ...args: unknown[]) => {
      const parsed = zObjectId.safeParse(args[0]);

      if (!parsed.success) {
        return { success: false };
      }

      return deps.deleteTranscriptionInternal(parsed.data);
    }
  );

  // Audio storage handlers
  ipcMain.handle(
    transcriptionDataChannels.saveTranscriptionAudio,
    async (_event, ...args: unknown[]) => {
      const parsedId = zObjectId.safeParse(args[0]);
      const parsedBuffer = binaryLikeSchema.safeParse(args[1]);

      if (!parsedId.success || !parsedBuffer.success) {
        return { success: false };
      }

      // SAFETY: Electron structured-clones the renderer's metadata bag; only the
      // three optional fields below are read, each defaulting to null.
      const meta = (args[2] ?? {}) as {
        durationMs?: number | null;
        provider?: string | null;
        model?: string | null;
      };

      const transcription = database.getTranscriptionById(parsedId.data);
      const timestamp = transcription?.timestamp || null;

      const result = audioStorage.saveAudio(
        parsedId.data,
        viewToBuffer(parsedBuffer.data),
        timestamp
      );

      if (result.success) {
        database.updateTranscriptionAudio(parsedId.data, {
          hasAudio: 1,
          audioDurationMs: meta.durationMs || null,
          provider: meta.provider || null,
          model: meta.model || null,
        });
        const updated = database.getTranscriptionById(parsedId.data);

        if (updated) deps.broadcast("transcription-updated", updated);
      }

      return result;
    }
  );

  ipcMain.handle(
    transcriptionDataChannels.mergeAudioSegments,
    async (_event, ...args: unknown[]) => {
      const segments = args[0];

      try {
        if (!isSegmentArray(segments) || segments.length < 2 || segments.length > 100) {
          throw new Error("Invalid audio segment count");
        }

        const normalized = segments.map((segment) => {
          if (!isAudioSegment(segment)) {
            throw new Error("Invalid audio segment");
          }

          return {
            buffer: viewToBuffer(segment.buffer),
            mimeType: segment.mimeType,
          };
        });

        const buffer = await mergeAudioSegments(normalized);

        // Slice to a real ArrayBuffer: Buffers sent over IPC arrive as Uint8Array,
        // and pooled Buffers share a larger underlying allocation.
        return {
          success: true as const,
          buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          mimeType: "audio/webm" as const,
        };
      } catch (error) {
        logger.error("Failed to merge recovered audio segments", {
          error: messageOf(error),
        });

        return { success: false as const, error: messageOf(error) };
      }
    }
  );

  ipcMain.handle(transcriptionDataChannels.getAudioPath, async (_event, ...args: unknown[]) => {
    const parsed = zObjectId.safeParse(args[0]);

    return parsed.success ? audioStorage.getAudioPath(parsed.data) : null;
  });

  ipcMain.handle(
    transcriptionDataChannels.showAudioInFolder,
    async (_event, ...args: unknown[]) => {
      const parsed = zObjectId.safeParse(args[0]);

      if (!parsed.success) return { success: false };
      const filePath = audioStorage.getAudioPath(parsed.data);

      if (!filePath) return { success: false };
      shell.showItemInFolder(filePath);

      return { success: true };
    }
  );

  ipcMain.handle(transcriptionDataChannels.getAudioBuffer, async (_event, ...args: unknown[]) => {
    const parsed = zObjectId.safeParse(args[0]);

    if (!parsed.success) return null;
    const buffer = audioStorage.getAudioBuffer(parsed.data);

    return buffer ? buffer.buffer : null;
  });

  ipcMain.handle(
    transcriptionDataChannels.deleteTranscriptionAudio,
    async (_event, ...args: unknown[]) => {
      const parsed = zObjectId.safeParse(args[0]);

      if (!parsed.success) return { success: false };
      const result = audioStorage.deleteAudio(parsed.data);

      if (result.success) {
        database.updateTranscriptionAudio(parsed.data, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
      }

      return result;
    }
  );

  ipcMain.handle(transcriptionDataChannels.getAudioStorageUsage, async () => {
    return audioStorage.getStorageUsage();
  });

  // Retention settings arrive from the owner window only; the handler keeps
  // the sweep gating main-side.
  ipcMain.on(
    transcriptionDataChannels.syncRetentionSettings,
    createRetentionSettingsHandler({
      getCurrentSettings: deps.retention.getCurrentSettings,
      getOwner: deps.retention.getOwner,
      hasSynced: deps.retention.hasSynced,
      onSettingsChanged: deps.retention.onSettingsChanged,
    })
  );

  ipcMain.handle(transcriptionDataChannels.deleteAllAudio, async () => {
    const result = await deps.deleteAllAudio();

    if (result.failed === 0)
      try {
        const rows = database.getAudioFlaggedIds();

        if (rows.length > 0) {
          database.clearAudioFlags(rows.map((r) => r.id));
        }
      } catch (error) {
        logger.error(
          "Failed to clear audio flags after delete-all",
          { error: messageOf(error) },
          "audio-storage"
        );
      }

    return result;
  });

  ipcMain.handle(
    transcriptionDataChannels.getTranscriptionById,
    async (_event, ...args: unknown[]) => {
      const parsed = zObjectId.safeParse(args[0]);

      return parsed.success ? database.getTranscriptionById(parsed.data) : null;
    }
  );

  ipcMain.handle(
    transcriptionDataChannels.updateTranscriptionText,
    async (_event, ...args: unknown[]) => {
      const parsed = zUpdateArgs.safeParse({ id: args[0], text: args[1], rawText: args[2] });

      if (!parsed.success) {
        return { success: false, error: "Invalid transcription update" };
      }

      try {
        database.updateTranscriptionText(parsed.data.id, parsed.data.text, parsed.data.rawText);
        const updated = database.getTranscriptionById(parsed.data.id);

        return { success: true, transcription: updated };
      } catch (error) {
        logger.error(
          "Failed to update transcription text",
          { id: parsed.data.id, error: messageOf(error) },
          "audio-storage"
        );

        return { success: false, error: messageOf(error) };
      }
    }
  );

  ipcMain.handle(transcriptionDataChannels.exportNote, async (_event, ...args: unknown[]) => {
    try {
      const parsed = zNoteExportArgs.safeParse({ noteId: args[0], format: args[1] });

      if (!parsed.success) return { success: false, error: "Invalid export request" };
      const note = database.getNote(parsed.data.noteId);

      if (!note) return { success: false, error: "Note not found" };

      const ext = parsed.data.format === "txt" ? "txt" : "md";
      const safeName = String(note.title || "Untitled").replace(SAFE_NAME_PATTERN, "-");

      const result = await dialog.showSaveDialog({
        defaultPath: `${safeName}.${ext}`,
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "Text", extensions: ["txt"] },
        ],
      });

      if (result.canceled || !result.filePath) return { success: false };

      const exportContent =
        parsed.data.format === "txt"
          ? formatTxtContent(note.content)
          : note.enhanced_content || note.content;

      fs.writeFileSync(result.filePath, exportContent ?? "", "utf-8");

      return { success: true };
    } catch (error) {
      logger.error("Error exporting note", { error: messageOf(error) }, "notes");

      return { success: false, error: messageOf(error) };
    }
  });

  ipcMain.handle(transcriptionDataChannels.exportTranscript, async (_event, ...args: unknown[]) => {
    try {
      const parsed = zTranscriptExportArgs.safeParse({ noteId: args[0], format: args[1] });

      if (!parsed.success) return { success: false, error: "Invalid export request" };
      const note = database.getNote(parsed.data.noteId);

      if (!note) return { success: false, error: "Note not found" };

      // SAFETY: the transcript column is written by this app as JSON of the
      // exported segment shape, so the persisted string decodes directly.
      const segments = JSON.parse(note.transcript || "[]") as TranscriptExportSegment[];

      if (!segments.length) return { success: false, error: "No transcript available" };

      const speakerMappings = deps.buildSpeakerMappings(parsed.data.noteId);
      const extMap: TranscriptExtensions = { srt: "srt", json: "json", md: "md" };
      const ext = extMap[parsed.data.format] || "txt";
      const safeName = String(note.title || "Untitled").replace(SAFE_NAME_PATTERN, "-");

      const result = await dialog.showSaveDialog({
        defaultPath: `${safeName}.${ext}`,
        filters: [
          { name: "Text", extensions: ["txt"] },
          { name: "SubRip Subtitles", extensions: ["srt"] },
          { name: "JSON", extensions: ["json"] },
          { name: "Markdown", extensions: ["md"] },
        ],
      });

      if (result.canceled || !result.filePath) return { success: false };

      let exportContent: string;

      if (parsed.data.format === "txt") {
        exportContent = formatTxt(note, segments, speakerMappings);
      } else if (parsed.data.format === "srt") {
        exportContent = formatSrt(segments, speakerMappings, note);
      } else if (parsed.data.format === "md") {
        exportContent = formatMd(note, segments, speakerMappings);
      } else {
        exportContent = formatJson(note, segments, speakerMappings);
      }

      fs.writeFileSync(result.filePath, exportContent, "utf-8");

      return { success: true };
    } catch (error) {
      logger.error("Error exporting transcript", { error: messageOf(error) }, "notes");

      return { success: false, error: messageOf(error) };
    }
  });

  ipcMain.handle(transcriptionDataChannels.exportDictionary, async (_event, ...args: unknown[]) => {
    try {
      const parsed = zWordList.safeParse(args[0]);

      if (!parsed.success) return { success: false, error: "Invalid dictionary export request" };

      const result = await dialog.showSaveDialog({
        defaultPath: "dictionary.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });

      if (result.canceled || !result.filePath) return { success: false };

      fs.writeFileSync(result.filePath, serializeDictionaryEntries(parsed.data), "utf-8");

      return { success: true };
    } catch (error) {
      logger.error("Error exporting dictionary", { error: messageOf(error) }, "dictionary");

      return { success: false, error: messageOf(error) };
    }
  });

  ipcMain.handle(transcriptionDataChannels.selectAudioFile, async (_event, ...args: unknown[]) => {
    const parsed = zSelectOptions.safeParse(args[0] ?? {});

    if (!parsed.success) return { canceled: true };
    const multiple = parsed.data.multiple === true;

    const properties: Array<"openFile" | "multiSelections"> = multiple
      ? ["openFile", "multiSelections"]
      : ["openFile"];

    const result = await dialog.showOpenDialog({
      properties,
      filters: [
        {
          name: "Audio Files",
          extensions: ["mp3", "wav", "m4a", "webm", "ogg", "oga", "flac", "aac", "opus"],
        },
      ],
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    result.filePaths.forEach(approveAudioPath);

    if (multiple) {
      return { canceled: false, filePaths: result.filePaths };
    }

    return { canceled: false, filePath: result.filePaths[0] };
  });

  // Fired by the preload's getPathForFile for real drag-dropped files; a
  // renderer-constructed File yields "" there, so this can't be forged.
  ipcMain.on(transcriptionDataChannels.approveAudioPath, (_event, ...args: unknown[]) => {
    approveAudioPath(args[0]);
  });

  ipcMain.handle(transcriptionDataChannels.getFileSize, async (_event, ...args: unknown[]) => {
    try {
      const filePath = args[0];

      if (!isString(filePath)) return 0;
      const real = resolveAllowedAudioPath(filePath);

      if (!real) return 0;
      const stats = fs.statSync(real);

      return stats.size;
    } catch {
      return 0;
    }
  });

  ipcMain.handle(transcriptionDataChannels.agentOpenNote, async (_event, ...args: unknown[]) => {
    const parsed = zObjectId.safeParse(args[0]);

    if (!parsed.success) {
      return { success: false, error: "Invalid note id" };
    }

    try {
      const note = database.getNote(parsed.data);

      await deps.queueNoteNavigation({
        noteId: parsed.data,
        folderId: note?.folder_id ?? null,
      });

      return { success: true };
    } catch (error) {
      logger.error("Failed to open note from agent:", error);

      return { success: false, error: messageOf(error) };
    }
  });

  ipcMain.handle(transcriptionDataChannels.getPendingNoteNavigation, async () =>
    deps.consumePendingNoteNavigation()
  );
}

// The shared boundary parsers for this module (ids are DB rowids; the update
// args mirror the positional channel arguments).
const zObjectId = z.number().int();

const zSaveTranscriptionArgs = z.tuple([
  z.string(),
  z.string().nullish(),
  z
    .object({
      status: z.string().optional(),
      errorMessage: z.string().nullish(),
      errorCode: z.string().nullish(),
      routeKind: z.string().nullish(),
      occurredAt: z.unknown().optional(),
    })
    .nullish(),
]);

const zGetTranscriptionsArgs = z.tuple([
  z.number().nullish(),
  z.object({ includeDiscarded: z.boolean().optional() }).nullish(),
]);

const zUpdateArgs = z.object({
  id: z.number().int(),
  text: z.string(),
  rawText: z.string().nullable(),
});

const zNoteExportArgs = z.object({
  noteId: z.number().int(),
  format: z.enum(["txt", "md"]),
});

const zTranscriptExportArgs = z.object({
  noteId: z.number().int(),
  format: z.enum(["txt", "srt", "json", "md"]),
});

const zWordList = z.array(z.string());

const zSelectOptions = z.object({
  multiple: z.boolean().optional(),
});
