// Internal persisted output contract. Public CLI JSON remains in noteRead.ts.
import { z } from "zod";
import {
  meetingProcessingResultDtoSchema,
  meetingProcessingRunDtoSchema,
  meetingRunStatusSchema,
} from "./meetingRecording.js";
import { noteTranscriptSchema } from "./noteRead.js";

export const noteOutputRequestSchema = z.discriminatedUnion("scope", [
  z.object({ noteId: z.number().int().positive(), scope: z.literal("note") }).strict(),
  z
    .object({
      noteId: z.number().int().positive(),
      scope: z.literal("run"),
      runId: z.string().uuid(),
    })
    .strict(),
]);

export type NoteOutputRequest = z.infer<typeof noteOutputRequestSchema>;

export const outputFreshnessSchema = z.object({
  status: z.enum(["current", "stale", "unknown"]),
  reasons: z.array(z.string()),
  revision: z.string().optional(),
});

export type OutputFreshness = z.infer<typeof outputFreshnessSchema>;

const provenance = z.object({
  source: z.enum(["note-manual", "note-projection", "run-artifact", "note-aggregate"]),
  runIds: z.array(z.string().uuid()),
});

const common = {
  noteId: z.number().int().positive(),
  currentRuns: z.array(
    z.object({
      recordingId: z.string().uuid(),
      runId: z.string().uuid().nullable(),
      status: meetingRunStatusSchema.nullable(),
    })
  ),
  manual: z.object({ text: z.string(), provenance, freshness: outputFreshnessSchema }),
  summaryProvenance: provenance,
  transcriptProvenance: provenance,
  summaryFreshness: outputFreshnessSchema,
  transcriptFreshness: outputFreshnessSchema,
  diagnostics: z.array(z.string()),
};

export const noteOutputSchema = z.discriminatedUnion("scope", [
  z.object({
    ...common,
    scope: z.literal("note"),
    summary: z.string().nullable(),
    transcript: noteTranscriptSchema,
    transcriptSources: z.array(
      z.object({ runId: z.string().uuid(), recordingIds: z.array(z.string().uuid()) })
    ),
  }),
  z.object({
    ...common,
    scope: z.literal("run"),
    runId: z.string().uuid(),
    run: meetingProcessingRunDtoSchema,
    result: meetingProcessingResultDtoSchema.nullable(),
  }),
]);

export type NoteOutput = z.infer<typeof noteOutputSchema>;
