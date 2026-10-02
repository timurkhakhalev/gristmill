// Public read contract for Notes (agent CLI, bridge routes and search).
// Internal runs, recordings and artifacts never appear here.
import { z } from "zod";

export type NoteTranscriptStatus = "ready" | "absent" | "pending" | "error" | "partial";

export interface NoteTranscriptSpeaker {
  id: string;
  name: string | null;
  name_source?: "user" | "voice" | "platform" | "model";
  name_platform?: "zoom" | "google-meet";
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

export const noteTranscriptSchema: z.ZodType<NoteTranscript> = z.object({
  note_id: z.number().int().positive(),
  status: z.enum(["ready", "absent", "pending", "error", "partial"]),
  timeline: z.object({
    unit: z.literal("ms"), duration_ms: z.number().nullable(),
    basis: z.literal("concatenated_recording_time"), intentional_pauses: z.literal("excluded"),
  }),
  speakers: z.array(z.object({
    id: z.string(), name: z.string().nullable(), email: z.string().nullable(),
    name_source: z.enum(["user", "voice", "platform", "model"]).optional(),
    name_platform: z.enum(["zoom", "google-meet"]).optional(),
    source: z.enum(["microphone", "system"]).nullable(),
  })),
  text: z.string().nullable(),
  segments: z.array(z.object({
    speaker_id: z.string().nullable(), start_ms: z.number().nullable(),
    end_ms: z.number().nullable(), text: z.string(),
  })).nullable(),
  diagnostics: z.array(z.string()),
});

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
