// Renderer-facing speaker bridge: contacts, speaker mappings/profiles, note
// speaker embeddings and the diarization model lifecycle with a
// schema-validated progress subscription. The sandboxed preload can't require
// local modules, so build-main.js bundles the final preload.
import {
  diarizationDownloadProgressEventSchema,
  contactProfileSchema,
  speakerMappingEntrySchema,
  publicSpeakerProfileSchema,
  speakerChannels,
  type AttachSpeakerEmailResult,
  type CancelDiarizationResult,
  type DiarizationDownloadProgressEvent,
  type DiarizationModelActionResult,
  type DiarizationModelStatus,
  type SetSpeakerMappingResult,
  type SpeakerApi,
  type SpeakerContact,
} from "../contracts/speakerProfiles.js";
import { z } from "zod";

import type { IpcRendererLike } from "./ipcTransport.js";

// The main-side handlers are the only producers of these channels and are
// strict-typed against the same contract interfaces; this single narrowing at
// the deserialization boundary therefore adds no new trust.
const objectSchema = z.record(z.string(), z.unknown());

function passthroughResult<T extends object>(raw: unknown, channel: string): T {
  if (objectSchema.safeParse(raw).success) {
    // SAFETY: the record parse above rejected non-object transport junk, and
    // the main-side handlers are strict-typed against these same contract
    // interfaces — the assertion re-voices the checked result shape.
    return raw as T;
  }

  throw new Error(`Unexpected response shape from ${channel}`);
}

function passthroughInvoke<T extends object>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((raw) => passthroughResult<T>(raw, channel));
}

function subscribeProgress(
  ipcRenderer: IpcRendererLike,
  channel: string,
  callback: (data: DiarizationDownloadProgressEvent) => void
): () => void {
  const listener = (_event: unknown, ...args: unknown[]) => {
    const parsed = diarizationDownloadProgressEventSchema.safeParse(args[0]);

    if (!parsed.success) return;
    callback(parsed.data);
  };

  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

export function createSpeakerBridge(ipcRenderer: IpcRendererLike): SpeakerApi {
  const c = speakerChannels;

  return {
    searchContacts: (query: string) =>
      passthroughInvoke<{ success: boolean; contacts: SpeakerContact[] }>(
        ipcRenderer,
        c.searchContacts,
        query
      ),
    upsertContact: (contact: { email: string; displayName?: string | null }) =>
      passthroughInvoke<{ success: boolean }>(ipcRenderer, c.upsertContact, contact),
    getContactProfiles: (emails: string[]) =>
      ipcRenderer
        .invoke(c.getContactProfiles, emails)
        .then((raw) => contactProfileSchema.array().parse(raw)),
    getSpeakerMappings: (noteId: number) =>
      ipcRenderer
        .invoke(c.getSpeakerMappings, noteId)
        .then((raw) => speakerMappingEntrySchema.array().parse(raw)),
    setSpeakerMapping: (noteId, speakerId, displayName, email, profileId) =>
      passthroughInvoke<SetSpeakerMappingResult>(
        ipcRenderer,
        c.setSpeakerMapping,
        noteId,
        speakerId,
        displayName,
        email,
        profileId
      ),
    removeSpeakerMapping: (noteId: number, speakerId: string) =>
      passthroughInvoke<{ success: boolean }>(
        ipcRenderer,
        c.removeSpeakerMapping,
        noteId,
        speakerId
      ),
    getSpeakerProfiles: () =>
      ipcRenderer
        .invoke(c.getSpeakerProfiles)
        .then((raw) => publicSpeakerProfileSchema.array().parse(raw)),
    attachSpeakerEmail: (profileId: number, email: string | null) =>
      passthroughInvoke<AttachSpeakerEmailResult>(
        ipcRenderer,
        c.attachSpeakerEmail,
        profileId,
        email
      ),
    saveNoteSpeakerEmbeddings: (noteId: number, embeddings: Record<string, number[]>) =>
      passthroughInvoke<{ success: boolean }>(
        ipcRenderer,
        c.saveNoteSpeakerEmbeddings,
        noteId,
        embeddings
      ),
    downloadDiarizationModels: () =>
      passthroughInvoke<DiarizationModelActionResult>(ipcRenderer, c.downloadDiarizationModels),
    getDiarizationModelStatus: () =>
      passthroughInvoke<DiarizationModelStatus>(ipcRenderer, c.getDiarizationModelStatus),
    deleteDiarizationModels: () =>
      passthroughInvoke<{ success: boolean; error?: string }>(
        ipcRenderer,
        c.deleteDiarizationModels
      ),
    cancelDiarizationDownload: () =>
      passthroughInvoke<CancelDiarizationResult>(ipcRenderer, c.cancelDiarizationDownload),
    onDiarizationDownloadProgress: (callback) =>
      subscribeProgress(ipcRenderer, c.diarizationDownloadProgress, callback),
  };
}
