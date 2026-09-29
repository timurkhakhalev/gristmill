// Public read contract for Notes (agent CLI, bridge routes and search).
// Internal runs, recordings and artifacts never appear here.

export type NoteTranscriptStatus = "ready" | "absent" | "pending" | "error" | "partial";

export interface NoteTranscriptSpeaker {
  id: string;
  name: string | null;
  email: string | null;
  source: "microphone" | "system" | null;
}

export interface NoteTranscriptSegment {
  speaker_id: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
}

export interface NoteTranscript {
  note_id: number;
  status: NoteTranscriptStatus;
  timeline: {
    unit: "ms";
    duration_ms: number | null;
    basis: "concatenated_recording_time";
    intentional_pauses: "excluded";
  };
  speakers: NoteTranscriptSpeaker[];
  text: string | null;
  segments: NoteTranscriptSegment[] | null;
  /** Present when the transcript is not a complete result, e.g. `part-uncovered`. */
  diagnostics: string[];
}

export interface TranscriptFilter {
  fromMs?: number;
  toMs?: number;
  speaker?: string;
}

export class NoteReadError extends Error {
  constructor(
    readonly code: "transcript_filter_unavailable" | "speaker_not_found",
    message: string
  ) {
    super(message);
  }
}
