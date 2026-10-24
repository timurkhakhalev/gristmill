// Renderer-facing speaker bridge: contacts, speaker mappings/profiles, note
// speaker embeddings and the diarization model lifecycle with a
// schema-validated progress subscription. The sandboxed preload can't require
// local modules, so build-main.js bundles the final preload.
import {
  diarizationDownloadProgressEventSchema,
  contactMutationResultSchema,
  legacyMentionContactSchema,
  setSpeakerMappingResultSchema,
  speakerContactSchema,
  attachSpeakerContactResultSchema,
  contactProfileSchema,
  speakerMappingEntrySchema,
  publicSpeakerProfileSchema,
  speakerChannels,
  type CancelDiarizationResult,
  type DiarizationDownloadProgressEvent,
  type DiarizationModelActionResult,
  type DiarizationModelStatus,
  type SpeakerApi,
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
    searchContacts: (query) =>
      ipcRenderer
        .invoke(c.searchContacts, query)
        .then((raw) =>
          z.object({ success: z.boolean(), contacts: speakerContactSchema.array() }).parse(raw)
        ),
    resolveLegacyMentionContacts: (emails) =>
      ipcRenderer
        .invoke(c.resolveLegacyMentionContacts, emails)
        .then((raw) => legacyMentionContactSchema.array().parse(raw)),
    createContact: (contact) =>
      ipcRenderer
        .invoke(c.createContact, contact)
        .then((raw) => contactMutationResultSchema.parse(raw)),
    updateContact: (id, contact) =>
      ipcRenderer
        .invoke(c.updateContact, id, contact)
        .then((raw) => contactMutationResultSchema.parse(raw)),
    getContactProfiles: (ids: number[]) =>
      ipcRenderer
        .invoke(c.getContactProfiles, ids)
        .then((raw) => contactProfileSchema.array().parse(raw)),
    getSpeakerMappings: (noteId: number) =>
      ipcRenderer
        .invoke(c.getSpeakerMappings, noteId)
        .then((raw) => speakerMappingEntrySchema.array().parse(raw)),
    setSpeakerMapping: (noteId, speakerId, displayName, contactId, profileId) =>
      ipcRenderer
        .invoke(c.setSpeakerMapping, noteId, speakerId, displayName, contactId, profileId)
        .then((raw) => setSpeakerMappingResultSchema.parse(raw)),
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
    attachSpeakerContact: (profileId, contactId) =>
      ipcRenderer
        .invoke(c.attachSpeakerContact, profileId, contactId)
        .then((raw) => attachSpeakerContactResultSchema.parse(raw)),
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
