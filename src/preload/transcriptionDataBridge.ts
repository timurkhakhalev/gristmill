// Renderer-facing transcription data/files bridge. Moved out of preload.js so
// the record/audio/export/file-selection operations and the four transcription
// events have one typed implementation backed by the shared contract. Results
// and event payloads are validated here: malformed events are dropped instead
// of forwarded, malformed results reject the invoke. The sandboxed preload
// can't require local modules, so build-main.js bundles the final preload.
import {
  transcriptionDataChannels,
  transcriptionDataEventChannels,
  transcriptionItemSchema,
  transcriptionListSchema,
  transcriptionOrNullSchema,
  transcriptionSaveResultSchema,
  transcriptionDeleteResultSchema,
  transcriptionClearResultSchema,
  transcriptionUpdateResultSchema,
  audioSaveResultSchema,
  mergeAudioSegmentsResultSchema,
  audioStorageUsageSchema,
  audioDeleteAllResultSchema,
  exportResultSchema,
  selectAudioFileResultSchema,
  transcriptionDeletedEventSchema,
  transcriptionsClearedEventSchema,
  pendingNoteNavigationSchema,
  type TranscriptionDataApi,
  type TranscriptionItem,
} from "../contracts/transcriptionData.js";
import { z } from "zod";

import type { IpcRendererLike } from "./ipcTransport.js";
import type { ZodType } from "zod";

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

// Main -> renderer events only reach the callback when the payload parses;
// junk is dropped on the preload boundary.
function subscribe<T>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  schema: ZodType<T>,
  deliver: (data: T) => void
): () => void {
  const listener = (_event: unknown, payload: unknown) => {
    const parsed = schema.safeParse(payload);

    if (parsed.success) {
      deliver(parsed.data);
    }
  };

  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// The return type is the shared TranscriptionDataApi, so any drift between
// this implementation and the contract fails compilation.
export function createTranscriptionDataBridge(ipcRenderer: IpcRendererLike): TranscriptionDataApi {
  const invokeParse = <T>(schema: ZodType<T>, channel: string, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args).then((raw) => parseResult(schema, raw, channel));

  return {
    saveTranscription: (text, rawText?, options?) =>
      invokeParse(
        transcriptionSaveResultSchema,
        transcriptionDataChannels.saveTranscription,
        text,
        rawText,
        options
      ),
    getTranscriptions: (limit?, options?) =>
      invokeParse(
        transcriptionListSchema,
        transcriptionDataChannels.getTranscriptions,
        limit,
        options
      ),
    clearTranscriptions: () =>
      invokeParse(transcriptionClearResultSchema, transcriptionDataChannels.clearTranscriptions),
    deleteTranscription: (id) =>
      invokeParse(
        transcriptionDeleteResultSchema,
        transcriptionDataChannels.deleteTranscription,
        id
      ),
    saveTranscriptionAudio: (id, audioBuffer, metadata) =>
      invokeParse(
        audioSaveResultSchema,
        transcriptionDataChannels.saveTranscriptionAudio,
        id,
        audioBuffer,
        metadata
      ),
    mergeAudioSegments: (segments) =>
      invokeParse(
        mergeAudioSegmentsResultSchema,
        transcriptionDataChannels.mergeAudioSegments,
        segments
      ),
    getAudioPath: (id) => invokeParse(zStringOrNull, transcriptionDataChannels.getAudioPath, id),
    showAudioInFolder: (id) =>
      invokeParse(zSuccess, transcriptionDataChannels.showAudioInFolder, id),
    getAudioBuffer: (id) =>
      invokeParse(zBufferOrNull, transcriptionDataChannels.getAudioBuffer, id),
    deleteTranscriptionAudio: (id) =>
      invokeParse(zSuccess, transcriptionDataChannels.deleteTranscriptionAudio, id),
    getAudioStorageUsage: () =>
      invokeParse(audioStorageUsageSchema, transcriptionDataChannels.getAudioStorageUsage),
    deleteAllAudio: () =>
      invokeParse(audioDeleteAllResultSchema, transcriptionDataChannels.deleteAllAudio),
    syncRetentionSettings: (settings) => {
      ipcRenderer.send(transcriptionDataChannels.syncRetentionSettings, settings);
    },
    getTranscriptionById: (id) =>
      invokeParse(transcriptionOrNullSchema, transcriptionDataChannels.getTranscriptionById, id),
    updateTranscriptionText: (id, text, rawText) =>
      invokeParse(
        transcriptionUpdateResultSchema,
        transcriptionDataChannels.updateTranscriptionText,
        id,
        text,
        rawText
      ),
    exportNote: (noteId, format) =>
      invokeParse(exportResultSchema, transcriptionDataChannels.exportNote, noteId, format),
    exportTranscript: (noteId, format) =>
      invokeParse(exportResultSchema, transcriptionDataChannels.exportTranscript, noteId, format),
    exportDictionary: (words) =>
      invokeParse(exportResultSchema, transcriptionDataChannels.exportDictionary, words),
    selectAudioFile: (options) =>
      invokeParse(selectAudioFileResultSchema, transcriptionDataChannels.selectAudioFile, options),
    getFileSize: (filePath) =>
      invokeParse(zNumber, transcriptionDataChannels.getFileSize, filePath),
    getPendingNoteNavigation: () =>
      invokeParse(pendingNoteNavigationSchema, transcriptionDataChannels.getPendingNoteNavigation),
    onNoteNavigationPending: (callback) => {
      // The event carries no payload — main only pings the panel.
      const listener = () => callback();
      ipcRenderer.on(transcriptionDataEventChannels.noteNavigationPending, listener);

      return () => {
        ipcRenderer.removeListener(transcriptionDataEventChannels.noteNavigationPending, listener);
      };
    },
    onTranscriptionAdded: (callback) =>
      subscribe(
        ipcRenderer,
        transcriptionDataEventChannels.transcriptionAdded,
        transcriptionItemSchema,
        (item: TranscriptionItem) => callback(item)
      ),
    onTranscriptionUpdated: (callback) =>
      subscribe(
        ipcRenderer,
        transcriptionDataEventChannels.transcriptionUpdated,
        transcriptionItemSchema,
        (item: TranscriptionItem) => callback(item)
      ),
    onTranscriptionDeleted: (callback) =>
      subscribe(
        ipcRenderer,
        transcriptionDataEventChannels.transcriptionDeleted,
        transcriptionDeletedEventSchema,
        (payload) => callback(payload)
      ),
    onTranscriptionsCleared: (callback) =>
      subscribe(
        ipcRenderer,
        transcriptionDataEventChannels.transcriptionsCleared,
        transcriptionsClearedEventSchema,
        (payload) => callback(payload)
      ),
  };
}

const zSuccess = z.object({ success: z.boolean() });

const zStringOrNull = z.string().nullable();

const zBufferOrNull = z.instanceof(ArrayBuffer).nullable();

const zNumber = z.number();
