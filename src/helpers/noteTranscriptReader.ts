import type {
  MeetingProcessingRunDto,
  MeetingRecordingDto,
  MeetingRecordingEpochDto,
  MeetingSpeakerCorrection,
  MeetingTranscriptArtifact,
} from "../contracts/meetingRecording.js";
import {
  NoteReadError,
  type NoteTranscript,
  type NoteTranscriptSegment,
  type NoteTranscriptSpeaker,
  type TranscriptFilter,
} from "../contracts/noteRead.js";
import { meetingTimelineFrameCount } from "./meetingAudioMixer.js";

const FRAMES_PER_MS = 24;

export interface NoteTranscriptDeps {
  listRecordings(noteId: number): MeetingRecordingDto[];
  listEpochs(recordingId: string): MeetingRecordingEpochDto[];
  getRun(runId: string): MeetingProcessingRunDto | null;
  readTranscript(runId: string): MeetingTranscriptArtifact | null;
  getCorrections(runId: string): MeetingSpeakerCorrection[];
  profileEmail(profileId: number): string | null;
  /** Stored `notes.transcript` JSON, used only for Notes without meeting recordings. */
  getProjection(noteId: number): string | null;
}

interface Piece {
  offsetMs: number;
  sourceIds: string[];
  runId: string;
  transcript: MeetingTranscriptArtifact;
  corrections: MeetingSpeakerCorrection[];
}

const emptyTimeline = (durationMs: number | null): NoteTranscript["timeline"] => ({
  unit: "ms",
  duration_ms: durationMs,
  basis: "concatenated_recording_time",
  intentional_pauses: "excluded",
});

function absent(noteId: number, status: NoteTranscript["status"], diagnostics: string[] = []): NoteTranscript {
  return { note_id: noteId, status, timeline: emptyTimeline(null), speakers: [], text: null, segments: null, diagnostics };
}

/**
 * Read-only assembly of one shared transcript for a Note.
 *
 * Parts follow start order across capture groups; intentional pauses are excluded.
 * A run's local time is shifted exactly once, by the offset of its first source part.
 * Coverage is shared across the Note so combined runs replace their per-part runs.
 */
export function readNoteTranscript(deps: NoteTranscriptDeps, noteId: number): NoteTranscript {
  const recordings = deps.listRecordings(noteId)
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  if (!recordings.length) return readProjection(deps, noteId);

  const diagnostics: string[] = [];

  const pieces: Piece[] = [];
  let durationMs = 0;
  let durationKnown = true;
  let pending = false;
  let failed = false;
  let uncovered = false;

  const partOffsets = new Map<string, number>();
  for (const part of recordings) {
    partOffsets.set(part.id, Math.round(durationMs));
    if (part.captureState === "recording" || part.captureState === "finalizing") {
      pending = true;
      durationKnown = false;
      continue;
    }
    if (part.captureState === "incomplete") {
      uncovered = true;
      diagnostics.push(`part-capture-incomplete:${part.id}`);
    }
    try {
      durationMs += meetingTimelineFrameCount(part, deps.listEpochs(part.id)) / FRAMES_PER_MS;
    } catch {
      durationKnown = false;
      diagnostics.push(`part-timeline-invalid:${part.id}`);
    }
  }

  const candidates = new Map<string, MeetingProcessingRunDto>();
  for (const part of recordings) {
    const current = part.currentRunId ? deps.getRun(part.currentRunId) : null;
    if (!current) continue;
    const transcriptRun = current.kind === "summary" && current.sourceRunId ? deps.getRun(current.sourceRunId) : current;
    if (transcriptRun) candidates.set(transcriptRun.id, transcriptRun);
  }
  // Prefer runs covering more parts; never take two runs over the same audio.
  const covered = new Set<string>();
  const orderedRuns = [...candidates.values()].sort(
    (a, b) => b.sourceRecordingIds.length - a.sourceRecordingIds.length || b.createdAt.localeCompare(a.createdAt)
  );
  for (const run of orderedRuns) {
    if (run.sourceRecordingIds.some((id) => covered.has(id))) continue;
    const transcript = run.hasTranscript ? deps.readTranscript(run.id) : null;
    if (!transcript) continue;
    const offset = partOffsets.get(run.sourceRecordingIds[0]);
    if (offset === undefined) continue;
    run.sourceRecordingIds.forEach((id) => covered.add(id));
    pieces.push({ offsetMs: offset, sourceIds: run.sourceRecordingIds, runId: run.id, transcript, corrections: deps.getCorrections(run.id) });
  }

  for (const part of recordings) {
    if (covered.has(part.id) || part.captureState === "recording" || part.captureState === "finalizing") continue;
    const runs = part.currentRunId ? [deps.getRun(part.currentRunId)] : [];
    if (runs.some((run) => run && (run.status === "pending" || run.status === "running"))) pending = true;
    else if (runs.some((run) => run && (run.status === "failed" || run.status === "blocked"))) failed = true;
    else uncovered = true;
    diagnostics.push(`part-uncovered:${part.id}`);
  }

  if (!pieces.length) {
    const status = pending ? "pending" : failed ? "error" : uncovered || !durationKnown ? "partial" : "absent";
    return { ...absent(noteId, status, diagnostics), timeline: emptyTimeline(durationKnown ? Math.round(durationMs) : null) };
  }

  pieces.sort((a, b) => a.offsetMs - b.offsetMs);
  const speakers: NoteTranscriptSpeaker[] = [];
  const speakerIds = new Map<string, string>();
  const speakerFor = (piece: Piece, provider: string): string => {
    const key = `${piece.runId}\u0000${provider}`;
    let id = speakerIds.get(key);
    if (!id) {
      id = `speaker_${speakerIds.size + 1}`;
      speakerIds.set(key, id);
      const correction = piece.corrections.find((item) => item.speakerId === provider);
      speakers.push({
        id,
        name: correction?.displayName ?? null,
        email: correction?.participantEmail ?? (correction?.profileId ? deps.profileEmail(correction.profileId) : null),
        source: provider === "mic" ? "microphone" : provider.startsWith("system:") ? "system" : null,
      });
    }
    return id;
  };

  const withSegments = pieces.every((piece) => piece.transcript.segments !== undefined);
  const ordered: Array<{ segment: NoteTranscriptSegment; order: number }> = [];
  if (withSegments) {
    pieces.forEach((piece, pieceIndex) => {
      (piece.transcript.segments ?? []).forEach((segment, index) => {
        ordered.push({
          order: pieceIndex * 1e9 + index,
          segment: {
            speaker_id: segment.speaker ? speakerFor(piece, segment.speaker) : null,
            start_ms: Math.round(segment.start * 1000) + piece.offsetMs,
            end_ms: Math.round(segment.end * 1000) + piece.offsetMs,
            text: segment.text,
          },
        });
      });
    });
    // Equal times keep source order so output is deterministic.
    ordered.sort((a, b) =>
      (a.segment.start_ms as number) - (b.segment.start_ms as number) ||
      (a.segment.end_ms as number) - (b.segment.end_ms as number) ||
      a.order - b.order
    );
  }
  const segments = ordered.map((item) => item.segment);

  return {
    note_id: noteId,
    status: pending || failed || uncovered || !durationKnown ? "partial" : "ready",
    timeline: emptyTimeline(durationKnown ? Math.round(durationMs) : null),
    speakers,
    text: withSegments ? segments.map((segment) => segment.text).join("\n") : pieces.map((piece) => piece.transcript.text).join("\n"),
    segments: withSegments ? segments : null,
    diagnostics,
  };
}

function readProjection(deps: NoteTranscriptDeps, noteId: number): NoteTranscript {
  const raw = deps.getProjection(noteId);
  if (!raw?.trim()) return absent(noteId, "absent");
  let parsed: unknown;
  try {
    parsed = raw.trimStart().startsWith("[") ? JSON.parse(raw) : null;
  } catch {
    return absent(noteId, "error", ["projection-invalid"]);
  }
  if (!Array.isArray(parsed)) {
    return { ...absent(noteId, "ready"), text: raw, diagnostics: [] };
  }
  if (parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    return absent(noteId, "error", ["projection-invalid"]);
  }
  const speakers: NoteTranscriptSpeaker[] = [];
  const ids = new Map<string, string>();
  const segments = parsed.map((item: Record<string, unknown>): NoteTranscriptSegment => {
    const label = typeof item.speaker === "string" ? item.speaker : null;
    let speakerId: string | null = null;
    if (label) {
      speakerId = ids.get(label) ?? null;
      if (!speakerId) {
        speakerId = `speaker_${ids.size + 1}`;
        ids.set(label, speakerId);
        speakers.push({
          id: speakerId,
          name: typeof item.speakerName === "string" ? item.speakerName : null,
          email: null,
          source: item.source === "mic" ? "microphone" : item.source === "system" ? "system" : null,
        });
      }
    }
    const start = typeof item.timestamp === "number" && Number.isFinite(item.timestamp) ? item.timestamp : null;
    const end = typeof item.endTimestamp === "number" && Number.isFinite(item.endTimestamp) ? item.endTimestamp : null;
    return {
      speaker_id: speakerId,
      start_ms: start === null ? null : Math.round(start * 1000),
      end_ms: end === null ? null : Math.round(end * 1000),
      text: typeof item.text === "string" ? item.text : "",
    };
  });
  const timed = segments.every((segment) => segment.start_ms !== null && segment.end_ms !== null);
  return {
    note_id: noteId,
    status: "ready",
    timeline: emptyTimeline(null),
    speakers,
    text: segments.map((segment) => segment.text).join("\n"),
    segments: timed ? segments : null,
    diagnostics: [],
  };
}

/** Restrict an assembled transcript. `text` and `segments` always describe the same selection. */
export function filterNoteTranscript(transcript: NoteTranscript, filter: TranscriptFilter): NoteTranscript {
  const { fromMs, toMs, speaker } = filter;
  if (fromMs === undefined && toMs === undefined && speaker === undefined) return transcript;
  if (transcript.text === null) return transcript;
  if (transcript.segments === null) {
    throw new NoteReadError(
      "transcript_filter_unavailable",
      "This transcript has no per-segment timing or speakers, so it cannot be filtered"
    );
  }
  if (speaker !== undefined && !transcript.speakers.some((item) => item.id === speaker)) {
    throw new NoteReadError("speaker_not_found", `Speaker ${speaker} is not in this transcript`);
  }
  const segments = transcript.segments.filter((segment) => {
    if (speaker !== undefined && segment.speaker_id !== speaker) return false;
    if (fromMs === undefined && toMs === undefined) return true;
    if (segment.start_ms === null || segment.end_ms === null) return false;
    return (toMs === undefined || segment.start_ms < toMs) && (fromMs === undefined || segment.end_ms > fromMs);
  });
  const used = new Set(segments.map((segment) => segment.speaker_id));
  return {
    ...transcript,
    speakers: transcript.speakers.filter((item) => used.has(item.id)),
    text: segments.map((segment) => segment.text).join("\n"),
    segments,
  };
}
