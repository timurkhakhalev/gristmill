// Final (background) diarization publication, moved out of ipcHandlers.js:
// the stop path's session snapshot feeds raw PCM + captured transcript
// segments here, and the enriched result is published to the owning window
// as meeting-diarization-complete — routed to the note/session that owned
// the recording, never to whatever recording started after the stop. Also
// hosts the speaker-roster projections shared with the notes/speaker
// verticals. Thresholds and provider payloads are unchanged.
import fs from "fs";
import type { DiarizationSegment } from "./diarization.js";
import {
  applyConfirmedSpeaker,
  applySuggestedSpeaker,
  isSpeakerLocked,
  type SpeakerSegment,
} from "./speakerAssignmentPolicy.js";
import { normalizeStoredSpeakerCount } from "./speakerCount.js";
import debugLogger from "./debugLogger.js";
import speakerDetection from "../constants/speakerDetection.json";

export const DEFAULT_EXPECTED_SPEAKER_COUNT: number = speakerDetection.DEFAULT_EXPECTED_SPEAKER_COUNT;
export const MAX_SPEAKER_COUNT: number = speakerDetection.MAX_SPEAKER_COUNT;

/** Transcript segment shape held by the coordinator and enriched at stop. */
export interface MeetingStoredSegment extends SpeakerSegment {
  id?: string;
  text: string;
  source: string;
  timestamp?: number | null;
  committedAt?: number;
  suppressionReason?: string | null;
  hasBleedEvidence?: boolean;
  likelyRenderBleed?: boolean;
}

export interface SpeakerEmbeddingsLike {
  isAvailable(): boolean;
  extractEmbedding(wavPath: string, startSec: number, endSec: number): Promise<Float32Array | null>;
  computeCentroid(embeddings: Float32Array[]): Float32Array;
  cosineSimilarity(a: Float32Array, b: Float32Array): number;
}

export interface DiarizationPublicationDiarizationManager {
  isAvailable(): boolean;
  convertRawPcmToWav(rawPcmPath: string, inputSampleRate: number): Promise<string>;
  diarize(wavPath: string, options: { numSpeakers?: number } | Record<string, never>): Promise<DiarizationSegment[]>;
  capSpeakerClusters(
    segments: DiarizationSegment[],
    cap: number | null | undefined
  ): DiarizationSegment[];
  mergeWithTranscript(
    transcriptSegments: MeetingStoredSegment[],
    diarizationSegments: DiarizationSegment[],
    options: { diarizedSource: string }
  ): MeetingStoredSegment[];
}

export interface DiarizationPublicationDatabase {
  getSpeakerProfiles(onlyWithEmail: boolean): Array<{
    id: number;
    display_name: string | null;
    email: string | null;
    embedding: Buffer;
  }>;
  upsertSpeakerProfile(
    displayName: string,
    email: string | null,
    embedding: Buffer
  ): { id: number };
  getSpeakerMappings(noteId: number): Array<{
    speaker_id: string;
    profile_id: number | null;
    display_name: string | null;
  }>;
  setSpeakerMapping(
    noteId: number,
    speakerId: string,
    profileId: number | null,
    displayName: string | null
  ): unknown;
  removeSpeakerMapping(noteId: number, speakerId: string): unknown;
  getNote(noteId: number): MeetingSpeakerRosterNote | null;
  getGoogleAccounts(): Array<{ email?: string | null }>;
}

export interface MeetingSpeakerRosterNote {
  id?: number;
  folder_id?: number | null;
  participants?: string | null;
  diarization_enabled?: number | boolean | null;
  expected_speaker_count?: unknown;
  [key: string]: unknown;
}

export interface MeetingSessionSpeakerConfig {
  enabled: boolean;
  expectedCount: number;
  explicit?: boolean;
}

interface MeetingParticipant {
  email?: string | null;
  displayName?: string | null;
  self?: boolean;
}

export interface DiarizationPublicationDeps {
  diarizationManager: DiarizationPublicationDiarizationManager;
  databaseManager: DiarizationPublicationDatabase;
  // Lazy like the pre-migration require: loading the embeddings module spins
  // up the ONNX worker client, which must stay out of IPC registration.
  speakerEmbeddings: () => SpeakerEmbeddingsLike;
  // The global diarization toggle (meeting-set-speaker-diarization-enabled).
  isDiarizationEnabled: () => boolean;
}

// ---- speaker roster projections (shared with notes/speaker verticals) ---------

export function parseNonSelfParticipants(
  deps: Pick<DiarizationPublicationDeps, "databaseManager">,
  participantsJson: string | null | undefined
): MeetingParticipant[] {
  if (!participantsJson) return [];
  let participants: unknown;
  try {
    participants = JSON.parse(participantsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(participants) || participants.length === 0) return [];
  const googleEmails = new Set(
    deps.databaseManager.getGoogleAccounts().map((a) => (a.email || "").toLowerCase())
  );
  return (participants as MeetingParticipant[]).filter(
    (p) => p && p.self !== true && !googleEmails.has((p.email || "").toLowerCase())
  );
}

export function getNoteNonSelfParticipants(
  deps: Pick<DiarizationPublicationDeps, "databaseManager">,
  noteId: number | null | undefined
): MeetingParticipant[] {
  if (!noteId) return [];
  try {
    const note = deps.databaseManager.getNote(noteId);
    return parseNonSelfParticipants(deps, note?.participants);
  } catch {
    return [];
  }
}

export function resolveOneOnOneOtherParticipant(
  deps: Pick<DiarizationPublicationDeps, "databaseManager">,
  participantsJson: string | null | undefined
): { displayName: string; email: string | null } | null {
  const others = parseNonSelfParticipants(deps, participantsJson);
  if (others.length !== 1) return null;
  const displayName = others[0].displayName || others[0].email;
  if (!displayName) return null;
  const email = (others[0].email || "").toLowerCase().trim() || null;
  return { displayName, email };
}

export function noteExpectedSpeakerCountOrNull(
  deps: Pick<DiarizationPublicationDeps, "databaseManager">,
  note: MeetingSpeakerRosterNote | null | undefined
): number | null {
  const stored = normalizeStoredSpeakerCount(note?.expected_speaker_count);
  if (stored != null) {
    return stored;
  }
  const others = parseNonSelfParticipants(deps, note?.participants).length;
  if (others > 0) {
    return Math.min(others + 1, MAX_SPEAKER_COUNT);
  }
  return null;
}

export function resolveNoteExpectedSpeakerCount(
  deps: Pick<DiarizationPublicationDeps, "databaseManager">,
  note: MeetingSpeakerRosterNote | null | undefined
): number {
  return noteExpectedSpeakerCountOrNull(deps, note) ?? DEFAULT_EXPECTED_SPEAKER_COUNT;
}

export function resolveInitialMeetingSpeakerConfig(
  deps: Pick<DiarizationPublicationDeps, "databaseManager" | "isDiarizationEnabled">,
  noteId: number | null | undefined
): MeetingSessionSpeakerConfig {
  let note: MeetingSpeakerRosterNote | null = null;
  if (noteId != null) {
    try {
      note = deps.databaseManager.getNote(noteId);
    } catch {
      note = null;
    }
  }
  const enabled =
    (note?.diarization_enabled == null
      ? deps.isDiarizationEnabled()
      : note.diarization_enabled !== 0) !== false;
  return { enabled, expectedCount: resolveNoteExpectedSpeakerCount(deps, note) };
}

// ---- diarization expectation / reconciliation / publication --------------------

export function applySpeakerName(
  segments: MeetingStoredSegment[],
  speakerId: string,
  displayName: string | null | undefined
): void {
  if (!displayName) {
    return;
  }

  for (const segment of segments) {
    if (segment.speaker !== speakerId) {
      continue;
    }

    applyConfirmedSpeaker(segment, {
      speakerName: displayName,
      speakerIsPlaceholder: false,
      suggestedName: undefined,
      suggestedProfileId: undefined,
    });
  }
}

export function reconcileLiveSpeakerState(
  deps: Pick<DiarizationPublicationDeps, "databaseManager" | "speakerEmbeddings">,
  liveSpeakerState: Record<string, unknown> | null,
  speakerEmbeddingsMap: Record<string, number[]> | null,
  enrichedSegments: MeetingStoredSegment[]
): Set<string> {
  if (!liveSpeakerState || !speakerEmbeddingsMap) {
    return new Set();
  }

  const speakerEmbeddings = deps.speakerEmbeddings();
  const reconciledSpeakers = new Set<string>();
  const usedLiveSpeakers = new Set<string>();
  const noteMappings = new Map<number, Array<{
    speaker_id: string;
    profile_id: number | null;
    display_name: string | null;
  }>>();

  const liveEntries = Object.entries(liveSpeakerState)
    .map(([speakerId, data]) => {
      const record = data as {
        displayName?: string | null;
        profileId?: number | null;
        noteId?: number | null;
        embedding?: unknown;
      } | null;
      return {
        speakerId,
        displayName: record?.displayName || null,
        profileId: record?.profileId ?? null,
        noteId: record?.noteId ?? null,
        embedding: Array.isArray(record?.embedding)
          ? new Float32Array(record?.embedding as number[])
          : null,
      };
    })
    .filter((entry) => entry.embedding);

  const getMappingsForNote = (noteId: number) => {
    const existing = noteMappings.get(noteId);
    if (existing) return existing;
    const mappings = deps.databaseManager.getSpeakerMappings(noteId);
    noteMappings.set(noteId, mappings);
    return mappings;
  };

  for (const [mappedId, embeddingArray] of Object.entries(speakerEmbeddingsMap)) {
    let bestEntry: (typeof liveEntries)[number] | null = null;
    let bestSimilarity = 0;

    for (const entry of liveEntries) {
      if (usedLiveSpeakers.has(entry.speakerId)) {
        continue;
      }

      const similarity = speakerEmbeddings.cosineSimilarity(
        new Float32Array(embeddingArray),
        entry.embedding as Float32Array
      );
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestEntry = entry;
      }
    }

    if (!bestEntry || bestSimilarity <= 0.6) {
      continue;
    }

    usedLiveSpeakers.add(bestEntry.speakerId);
    reconciledSpeakers.add(mappedId);

    const best = bestEntry;
    let displayName = best.displayName;
    let profileId = best.profileId;

    if (best.noteId) {
      const liveMapping = getMappingsForNote(best.noteId).find(
        (mapping) => mapping.speaker_id === best.speakerId
      );
      if (liveMapping) {
        displayName = liveMapping.display_name || displayName;
        profileId = liveMapping.profile_id ?? profileId;
        deps.databaseManager.setSpeakerMapping(best.noteId, mappedId, profileId, displayName);
        // Live and offline ids share one namespace now, so they often match —
        // removing the "old" row would delete the mapping just written.
        if (best.speakerId !== mappedId) {
          deps.databaseManager.removeSpeakerMapping(best.noteId, best.speakerId);
        }
      } else if (displayName) {
        deps.databaseManager.setSpeakerMapping(best.noteId, mappedId, profileId, displayName);
      }
    }

    applySpeakerName(enrichedSegments, mappedId, displayName);
  }

  return reconciledSpeakers;
}

export function resolveSpeakerExpectation({
  deps,
  sessionConfig,
  noteId,
  observedSpeakerIds,
  diarizedSource,
}: {
  deps: Pick<DiarizationPublicationDeps, "databaseManager">;
  sessionConfig: MeetingSessionSpeakerConfig | null;
  noteId: number | null;
  observedSpeakerIds: Set<string>;
  diarizedSource: string;
}): { numSpeakers: number; cap: number } {
  // Only a count the user set explicitly outranks the note: participants added
  // mid-meeting postdate the config snapshot taken at recording start.
  let expectedTotal = sessionConfig?.explicit ? sessionConfig.expectedCount : null;

  if (!expectedTotal && noteId != null) {
    try {
      expectedTotal = noteExpectedSpeakerCountOrNull(deps, deps.databaseManager.getNote(noteId));
    } catch {
      expectedTotal = null;
    }
  }

  // Diarizing the mic track (in-person session) means the user is one of the
  // diarized voices, so the expected total applies without the -1 the
  // system-audio branches use.
  const micMode = diarizedSource === "mic";

  if (expectedTotal) {
    const total = Math.min(expectedTotal, MAX_SPEAKER_COUNT);
    const numSpeakers = micMode ? total : Math.max(1, total - 1);
    return { numSpeakers, cap: numSpeakers };
  }

  if (observedSpeakerIds.size >= 2) {
    const numSpeakers = Math.min(observedSpeakerIds.size, MAX_SPEAKER_COUNT);
    return { numSpeakers, cap: numSpeakers };
  }

  if (micMode) {
    return { numSpeakers: -1, cap: DEFAULT_EXPECTED_SPEAKER_COUNT };
  }

  // Only system audio reaches the diarizer (the mic track is "you"), so the cap
  // counts other speakers — same total - 1 basis as the branches above.
  return { numSpeakers: -1, cap: Math.max(1, DEFAULT_EXPECTED_SPEAKER_COUNT - 1) };
}

export interface MeetingDiarizationPublicationInput {
  sessionId: string;
  rawPcmPath: string | null;
  audioStartedAt: number | null;
  transcriptSegments: MeetingStoredSegment[];
  win: {
    isDestroyed(): boolean;
    webContents: { send(channel: string, payload: unknown): void };
  } | null;
  liveSpeakerState?: Record<string, unknown> | null;
  sessionConfig?: MeetingSessionSpeakerConfig | null;
  noteId?: number | null;
  diarizedSource?: string;
}

/**
 * The former `IPCHandlers._startOrSkipDiarization`. Publishes enriched
 * segments when diarization can run, or the plain transcript (with stable
 * segment ids) when it cannot. Late results are sent to the window captured
 * at stop, keyed by the original sessionId/noteId.
 */
export function startOrSkipMeetingDiarization(
  deps: DiarizationPublicationDeps,
  {
    sessionId,
    rawPcmPath,
    audioStartedAt,
    transcriptSegments,
    win,
    liveSpeakerState = null,
    sessionConfig = null,
    noteId = null,
    diarizedSource = "system",
  }: MeetingDiarizationPublicationInput
): void {
  const send = (payload: Record<string, unknown>): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("meeting-diarization-complete", { sessionId, noteId, ...payload });
    }
  };

  const diarizationEnabled =
    (sessionConfig?.enabled ?? deps.isDiarizationEnabled()) !== false;

  if (!diarizationEnabled || !deps.diarizationManager.isAvailable() || !rawPcmPath) {
    send({
      segments: transcriptSegments.map((segment, index) => ({
        ...segment,
        id: segment.id || `segment-${index}`,
      })),
    });
    return;
  }

  (async () => {
    let tmpWav: string | null = null;
    try {
      tmpWav = await deps.diarizationManager.convertRawPcmToWav(rawPcmPath, 24000);
      const observedSpeakerIds = new Set(
        transcriptSegments
          .filter((segment) => segment.source === "system" && segment.speaker)
          .map((segment) => segment.speaker as string)
      );
      for (const speakerId of Object.keys(liveSpeakerState || {})) {
        observedSpeakerIds.add(speakerId);
      }

      if (observedSpeakerIds.size > 10) {
        debugLogger.warn("Excessive speaker count from live identification", {
          observedSpeakers: observedSpeakerIds.size,
        });
      }

      const { numSpeakers, cap } = resolveSpeakerExpectation({
        deps,
        sessionConfig,
        noteId,
        observedSpeakerIds,
        diarizedSource,
      });
      let diarizationSegments = await deps.diarizationManager.diarize(
        tmpWav,
        numSpeakers > 0 ? { numSpeakers } : {}
      );
      if (cap != null) {
        diarizationSegments = deps.diarizationManager.capSpeakerClusters(
          diarizationSegments,
          cap
        );
      }

      const startMs =
        (Number.isFinite(audioStartedAt) && audioStartedAt) ||
        transcriptSegments.find((segment) => segment.source === diarizedSource)?.timestamp ||
        transcriptSegments[0]?.timestamp ||
        0;
      const isEpochMs = (startMs ?? 0) > 1e9;
      const normalized = transcriptSegments.map((seg) => ({
        ...seg,
        timestamp:
          seg.timestamp != null
            ? isEpochMs
              ? (seg.timestamp - (startMs as number)) / 1000
              : seg.timestamp
            : undefined,
      }));

      const enrichedSegments = deps.diarizationManager.mergeWithTranscript(
        normalized,
        diarizationSegments,
        { diarizedSource }
      );

      const speakerSet = new Set(diarizationSegments.map((d) => d.speaker));
      const speakerRenumber = new Map<string, string>();
      let sIdx = 0;
      for (const sp of speakerSet) {
        speakerRenumber.set(sp, `speaker_${sIdx}`);
        sIdx++;
      }

      // Mirrors the mic-mode single-cluster softening in mergeWithTranscript:
      // every segment stays "you", so persisting an embedding keyed to a
      // cluster id that owns no segments would leave the note inconsistent.
      const micSingleClusterSoftened = diarizedSource === "mic" && speakerSet.size === 1;

      let speakerEmbeddingsMap: Record<string, number[]> | null = null;
      const speakerEmb = deps.speakerEmbeddings();
      try {
        if (!micSingleClusterSoftened && speakerEmb.isAvailable() && tmpWav) {
          const speakerIds = [...new Set(diarizationSegments.map((s) => s.speaker))];
          speakerEmbeddingsMap = {};

          for (const spk of speakerIds) {
            const segs = diarizationSegments
              .filter((s) => s.speaker === spk)
              .sort((a, b) => b.end - b.start - (a.end - a.start))
              .slice(0, 3);
            const embeddings: Float32Array[] = [];
            for (const seg of segs) {
              if (seg.end - seg.start < 1.5) continue;
              const emb = await speakerEmb.extractEmbedding(tmpWav, seg.start, seg.end);
              if (emb) embeddings.push(emb);
            }
            if (embeddings.length > 0) {
              const centroid = speakerEmb.computeCentroid(embeddings);
              const mappedId = speakerRenumber.get(spk) || spk;
              speakerEmbeddingsMap[mappedId] = Array.from(centroid);
            }
          }
        }
      } catch (err) {
        debugLogger.debug("Speaker embedding extraction skipped", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const reconciledSpeakers = reconcileLiveSpeakerState(
        deps,
        liveSpeakerState,
        speakerEmbeddingsMap,
        enrichedSegments
      );

      if (speakerEmbeddingsMap) {
        try {
          const profiles = deps.databaseManager.getSpeakerProfiles(true);

          if (profiles.length > 0) {
            for (const [mappedId, embArr] of Object.entries(speakerEmbeddingsMap)) {
              const alreadyMapped = enrichedSegments.some(
                (segment) => segment.speaker === mappedId && segment.speakerName
              );
              if (reconciledSpeakers.has(mappedId) || alreadyMapped) {
                continue;
              }

              const emb = new Float32Array(embArr);
              let bestProfile: (typeof profiles)[number] | null = null;
              let bestSim = 0;

              for (const profile of profiles) {
                const profileEmb = new Float32Array(
                  profile.embedding.buffer,
                  profile.embedding.byteOffset,
                  profile.embedding.byteLength / 4
                );
                const sim = speakerEmb.cosineSimilarity(emb, profileEmb);
                if (sim > bestSim) {
                  bestSim = sim;
                  bestProfile = profile;
                }
              }

              if (bestProfile && bestSim > 0.6) {
                for (const seg of enrichedSegments) {
                  if (seg.speaker === mappedId) {
                    applyConfirmedSpeaker(seg, {
                      speakerName: bestProfile.display_name,
                      speakerIsPlaceholder: false,
                      suggestedName: undefined,
                      suggestedProfileId: undefined,
                    });
                  }
                }
              } else if (bestProfile && bestSim > 0.5) {
                for (const seg of enrichedSegments) {
                  if (seg.speaker === mappedId) {
                    if (isSpeakerLocked(seg)) {
                      continue;
                    }
                    applySuggestedSpeaker(seg, {
                      suggestedName: bestProfile.display_name,
                      suggestedProfileId: bestProfile.id,
                    });
                  }
                }
              }
            }
          }
        } catch (err) {
          debugLogger.debug("Auto speaker recognition skipped", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      send({ segments: enrichedSegments, speakerEmbeddings: speakerEmbeddingsMap });
    } catch (err) {
      debugLogger.warn("Background diarization failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      send({ segments: [] });
    } finally {
      try {
        fs.unlinkSync(rawPcmPath as string);
      } catch {
        // The raw capture may already be gone after a crash-adjacent retry.
      }
      if (tmpWav) {
        try {
          fs.unlinkSync(tmpWav);
        } catch {
          // Best-effort temp cleanup.
        }
      }
    }
  })();
}
