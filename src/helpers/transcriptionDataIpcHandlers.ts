// The transcription data/files IPC handlers, moved out of ipcHandlers.js:
// the db-* record channels, audio storage/merge/reveal, retention settings
// sync, note/transcript/dictionary exports, audio file selection/approval/
// size, agent note opening and the pending (non-meeting) note navigation.
// Channels, argument order, results, events and errors are unchanged;
// untrusted payloads are parsed at the boundary and only validated values
// reach the managers.
import { dialog, shell } from "electron";
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
  type TranscriptionDeleteResult,
} from "../contracts/transcriptionData.js";
import type { NoteRow, TranscriptionRow } from "./database.js";
import type { Logger } from "./transcriptionExecutionIpcHandlers.js";

export interface TranscriptionDataDeps {
  // Method syntax keeps parameter checks bivariant so the real
  // DatabaseManager satisfies this without casts; the handler validates
  // untrusted IPC payloads itself before any database call.
  database: {
    saveTranscription(
      text: unknown,
      rawText: unknown,
      options: unknown
    ): { success: boolean; transcription: TranscriptionRow | null } | null | undefined;
    getTranscriptions(limit: unknown, options: unknown): TranscriptionRow[];
    clearTranscriptions(): { success: boolean; cleared: number };
    deleteTranscription(id: number): unknown;
    updateTranscriptionAudio: (
      id: number,
      update: {
        hasAudio: number;
        audioDurationMs: number | null;
        provider: string | null;
        model: string | null;
      }
    ) => unknown;
    getTranscriptionById: (id: number) => (TranscriptionRow & Record<string, unknown>) | null;
    updateTranscriptionText: (id: number, text: string, rawText: string | null) => unknown;
    getAudioFlaggedIds: () => Array<{ id: number }>;
    clearAudioFlags: (ids: number[]) => unknown;
    getNote: (id: number) => NoteRow | null;
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
  deleteTranscriptionInternal: (id: number) => unknown;
  buildSpeakerMappings: (noteId: number) => Record<string, string>;
  queueNoteNavigation: (payload: { noteId: number; folderId: number | null }) => Promise<void>;
  consumePendingNoteNavigation: () => unknown;
  retention: {
    getCurrentSettings: () => RetentionSettings;
    getOwner: () => unknown;
    hasSynced: () => boolean;
    onSettingsChanged: (settings: RetentionSettings) => void;
  };
  broadcast: (channel: string, payload: unknown) => void;
  logger: Logger;
}

const SAFE_NAME_PATTERN = /[/\\?%*:|"<>]/g;

function viewToBuffer(value: ArrayBuffer | ArrayBufferView): Buffer {
  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }

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

export function registerTranscriptionDataHandlers(
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
    // `never` parameters accept the narrower handler signatures some shared
    // listener factories (retention settings) are typed with.
    on(channel: string, listener: (event: { sender?: unknown }, ...args: unknown[]) => void): void;
  },
  deps: TranscriptionDataDeps
): void {
  const { logger, database, audioStorage } = deps;

  ipcMain.handle(
    transcriptionDataChannels.saveTranscription,
    async (_event, text: unknown, rawText: unknown, options: unknown) => {
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
    async (_event, limit: unknown, options: unknown) => {
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

  ipcMain.handle(transcriptionDataChannels.deleteTranscription, async (_event, id: unknown) => {
    const parsed = zObjectId.safeParse(id);

    if (!parsed.success) {
      return { success: false };
    }

    return deps.deleteTranscriptionInternal(parsed.data) as TranscriptionDeleteResult;
  });

  // Audio storage handlers
  ipcMain.handle(
    transcriptionDataChannels.saveTranscriptionAudio,
    async (_event, id: unknown, audioBuffer: unknown, metadata: unknown) => {
      const parsedId = zObjectId.safeParse(id);
      const parsedBuffer = binaryLikeSchema.safeParse(audioBuffer);

      if (!parsedId.success || !parsedBuffer.success) {
        return { success: false };
      }

      const meta = (metadata ?? {}) as {
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
          audioDurationMs: meta?.durationMs || null,
          provider: meta?.provider || null,
          model: meta?.model || null,
        });
        const updated = database.getTranscriptionById(parsedId.data);

        if (updated) deps.broadcast("transcription-updated", updated);
      }

      return result;
    }
  );

  ipcMain.handle(
    transcriptionDataChannels.mergeAudioSegments,
    async (_event, segments: unknown) => {
      try {
        if (!Array.isArray(segments) || segments.length < 2 || segments.length > 100) {
          throw new Error("Invalid audio segment count");
        }

        const normalized = segments.map((segment) => {
          const record = segment as { buffer?: unknown; mimeType?: unknown } | null;

          if (!record?.buffer || typeof record.mimeType !== "string") {
            throw new Error("Invalid audio segment");
          }

          return {
            buffer: viewToBuffer(record.buffer as ArrayBuffer | ArrayBufferView),
            mimeType: record.mimeType,
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
          error: (error as Error).message,
        });

        return { success: false as const, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(transcriptionDataChannels.getAudioPath, async (_event, id: unknown) => {
    const parsed = zObjectId.safeParse(id);

    return parsed.success ? audioStorage.getAudioPath(parsed.data) : null;
  });

  ipcMain.handle(transcriptionDataChannels.showAudioInFolder, async (_event, id: unknown) => {
    const parsed = zObjectId.safeParse(id);

    if (!parsed.success) return { success: false };
    const filePath = audioStorage.getAudioPath(parsed.data);

    if (!filePath) return { success: false };
    shell.showItemInFolder(filePath);

    return { success: true };
  });

  ipcMain.handle(transcriptionDataChannels.getAudioBuffer, async (_event, id: unknown) => {
    const parsed = zObjectId.safeParse(id);

    if (!parsed.success) return null;
    const buffer = audioStorage.getAudioBuffer(parsed.data);

    return buffer ? buffer.buffer : null;
  });

  ipcMain.handle(
    transcriptionDataChannels.deleteTranscriptionAudio,
    async (_event, id: unknown) => {
      const parsed = zObjectId.safeParse(id);

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
          { error: (error as Error).message },
          "audio-storage"
        );
      }

    return result;
  });

  ipcMain.handle(transcriptionDataChannels.getTranscriptionById, async (_event, id: unknown) => {
    const parsed = zObjectId.safeParse(id);

    return parsed.success ? database.getTranscriptionById(parsed.data) : null;
  });

  ipcMain.handle(
    transcriptionDataChannels.updateTranscriptionText,
    async (_event, id: unknown, text: unknown, rawText: unknown) => {
      const parsed = zUpdateArgs.safeParse({ id, text, rawText });

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
          { id: parsed.data.id, error: (error as Error).message },
          "audio-storage"
        );

        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(
    transcriptionDataChannels.exportNote,
    async (_event, noteId: unknown, format: unknown) => {
      try {
        const parsed = zNoteExportArgs.safeParse({ noteId, format });

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
        logger.error("Error exporting note", { error: (error as Error).message }, "notes");

        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(
    transcriptionDataChannels.exportTranscript,
    async (_event, noteId: unknown, format: unknown) => {
      try {
        const parsed = zTranscriptExportArgs.safeParse({ noteId, format });

        if (!parsed.success) return { success: false, error: "Invalid export request" };
        const note = database.getNote(parsed.data.noteId);

        if (!note) return { success: false, error: "Note not found" };

        const segments = JSON.parse(note.transcript || "[]") as TranscriptExportSegment[];

        if (!segments.length) return { success: false, error: "No transcript available" };

        const speakerMappings = deps.buildSpeakerMappings(parsed.data.noteId);
        const extMap = { srt: "srt", json: "json", md: "md" } as Record<string, string>;
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
        logger.error("Error exporting transcript", { error: (error as Error).message }, "notes");

        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(transcriptionDataChannels.exportDictionary, async (_event, words: unknown) => {
    try {
      const parsed = zWordList.safeParse(words);

      if (!parsed.success) return { success: false, error: "Invalid dictionary export request" };

      const result = await dialog.showSaveDialog({
        defaultPath: "dictionary.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });

      if (result.canceled || !result.filePath) return { success: false };

      fs.writeFileSync(result.filePath, serializeDictionaryEntries(parsed.data), "utf-8");

      return { success: true };
    } catch (error) {
      logger.error("Error exporting dictionary", { error: (error as Error).message }, "dictionary");

      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(transcriptionDataChannels.selectAudioFile, async (_event, options: unknown) => {
    const parsed = zSelectOptions.safeParse(options ?? {});

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
  ipcMain.on(transcriptionDataChannels.approveAudioPath, (_event, filePath: unknown) => {
    approveAudioPath(filePath);
  });

  ipcMain.handle(transcriptionDataChannels.getFileSize, async (_event, filePath: unknown) => {
    try {
      if (typeof filePath !== "string") return 0;
      const real = resolveAllowedAudioPath(filePath);

      if (!real) return 0;
      const stats = fs.statSync(real);

      return stats.size;
    } catch {
      return 0;
    }
  });

  ipcMain.handle(transcriptionDataChannels.agentOpenNote, async (_event, noteId: unknown) => {
    const parsed = zObjectId.safeParse(noteId);

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

      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(transcriptionDataChannels.getPendingNoteNavigation, async () =>
    deps.consumePendingNoteNavigation()
  );
}

// The shared boundary parsers for this module (ids are DB rowids; the update
// args mirror the positional channel arguments).
const zObjectId = z.number().int();

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
