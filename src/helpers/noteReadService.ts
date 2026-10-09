import { createHash } from "node:crypto";
import {
  noteOutputRequestSchema,
  noteOutputSchema,
  type NoteOutputRequest,
  type NoteOutput,
  type OutputFreshness,
} from "../contracts/noteOutput.js";
import {
  meetingLlmSourceSnapshotSchema,
  meetingRunAudioPartIds,
  type MeetingProcessingRunDto,
  type MeetingSummaryArtifact,
} from "../contracts/meetingRecording.js";
import { readMeetingRunOutput } from "./meetingRunReader.js";
import { parseMeetingParticipants } from "./meetingPromptMaterial.js";
import type { DatabaseManager, NoteRow } from "./database.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";
import { meetingTranscriptArtifactSchema } from "../contracts/meetingRecording.js";
import { filterNoteTranscript, readNoteTranscriptOutput } from "./noteTranscriptReader.js";
import { noteSearchTokens } from "./noteSearch.js";
import type { NoteTranscript, TranscriptFilter } from "../contracts/noteRead.js";

type Scope = { from?: string; to?: string; note?: number };

function createdDate(value: string): Date {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

function localDate(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function localTimestamp(value: string): string {
  const date = createdDate(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;

  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}

function inScope(note: NoteRow, scope: Scope): boolean {
  const date = localDate(createdDate(note.created_at));

  return (
    (scope.note === undefined || scope.note === note.id) &&
    (scope.from === undefined || date >= scope.from) &&
    (scope.to === undefined || date <= scope.to)
  );
}

function matches(text: string, tokens: string[]): boolean {
  const words = noteSearchTokens(text).map((word) => word.toLocaleLowerCase());

  return (
    tokens.length > 0 &&
    tokens.every((token) => words.some((word) => word.startsWith(token.toLocaleLowerCase())))
  );
}

function snippet(text: string, tokens: string[]): string {
  const words = [...text.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)];

  const first = words.find((word) =>
    tokens.some((token) => word[0].toLocaleLowerCase().startsWith(token.toLocaleLowerCase()))
  );

  const at = first?.index ?? 0;

  return text
    .slice(Math.max(0, at - 60), Math.min(text.length, at + 160))
    .replace(/\s+/g, " ")
    .trim();
}

export class NoteReadService {
  constructor(
    private readonly db: DatabaseManager,
    private readonly storage: MeetingRecordingStorage
  ) {}

  transcript(noteId: number, filter: TranscriptFilter = {}): NoteTranscript {
    return filterNoteTranscript(this.transcriptOutput(noteId).transcript, filter);
  }

  private transcriptOutput(noteId: number) {
    return readNoteTranscriptOutput(
      {
        listRecordings: (id) => this.db.listMeetingRecordingsForNote(id),
        listEpochs: (id) => this.db.listMeetingRecordingEpochs(id),
        getRun: (id) => this.db.getMeetingProcessingRun(id),
        readTranscript: (id) => {
          const artifact = this.storage.readRunArtifact(id, "transcript");

          if (artifact === null) return null;

          return meetingTranscriptArtifactSchema.parse(artifact);
        },
        getCorrections: (id) => this.db.getMeetingRunSpeakerCorrections(id),
        profileEmail: (id) =>
          this.db.getSpeakerProfiles().find((profile) => profile.id === id)?.email ?? null,
        getProjection: (id) => this.db.getNote(id)?.transcript ?? null,
      },
      noteId
    );
  }

  readOutput(input: NoteOutputRequest): NoteOutput {
    const request = noteOutputRequestSchema.parse(input);
    const note = this.db.getNote(request.noteId);

    if (!note) throw new Error("note-output-not-found");
    const recordings = this.db.listMeetingRecordingsForNote(note.id);

    const common = {
      noteId: note.id,
      currentRuns: recordings.map((recording) => ({
        recordingId: recording.id,
        runId: recording.currentRunId,
        status: recording.currentRunId
          ? (this.db.getMeetingProcessingRun(recording.currentRunId)?.status ?? null)
          : null,
      })),
      manual: {
        text: note.content,
        provenance: { source: "note-manual", runIds: [] },
        freshness: { status: "current", reasons: [] },
      },
    };

    if (request.scope === "note") {
      let output: ReturnType<NoteReadService["transcriptOutput"]>;

      try {
        output = this.transcriptOutput(note.id);
      } catch {
        output = {
          sources: [],
          transcript: {
            note_id: note.id,
            status: "error",
            text: null,
            segments: null,
            speakers: [],
            timeline: {
              unit: "ms",
              duration_ms: null,
              basis: "concatenated_recording_time",
              intentional_pauses: "excluded",
            },
            diagnostics: ["transcript-artifact-invalid"],
          },
        };
      }

      return noteOutputSchema.parse({
        ...common,
        scope: "note",
        summary: note.enhanced_content || null,
        transcript: output.transcript,
        transcriptSources: output.sources,
        summaryProvenance: { source: "note-projection", runIds: [] },
        transcriptProvenance: {
          source: recordings.length ? "note-aggregate" : "note-projection",
          runIds: output.sources.map((source) => source.runId),
        },
        summaryFreshness: { status: "unknown", reasons: ["projection-origin-unrecorded"] },
        transcriptFreshness: {
          status: recordings.length && output.transcript.status === "ready" ? "current" : "unknown",
          reasons: recordings.length
            ? output.transcript.diagnostics
            : ["projection-origin-unrecorded"],
        },
        diagnostics: output.transcript.diagnostics,
      });
    }

    const run = this.db.getMeetingProcessingRun(request.runId);

    const ownsRun = (candidate: MeetingProcessingRunDto | null) =>
      Boolean(
        candidate &&
        this.db.getMeetingRecording(candidate.recordingId)?.noteId === note.id &&
        candidate.sourceRecordingIds.every(
          (id) => this.db.getMeetingRecording(id)?.noteId === note.id
        )
      );

    if (!ownsRun(run) || !run) throw new Error("note-output-run-not-owned");

    const sourceRun =
      run.kind === "summary" && run.sourceRunId
        ? this.db.getMeetingProcessingRun(run.sourceRunId)
        : run;

    if (!ownsRun(sourceRun)) throw new Error("note-output-source-not-owned");
    let result: ReturnType<typeof readMeetingRunOutput> | null = null;
    const diagnostics: string[] = [];

    try {
      result = readMeetingRunOutput(this.db, this.storage, run);
    } catch (error) {
      diagnostics.push(
        // SAFETY: the reader throws plain errors whose optional `code` carries
        // the failure kind; a non-Error throw has no code and falls back.
        (error as { code?: string }).code ?? "run-artifact-invalid"
      );
    }

    if (result && !result.result.transcript) diagnostics.push("transcript-artifact-missing");

    if (result && !result.result.summary) diagnostics.push("summary-artifact-missing");

    const transcriptRunId =
      result?.transcriptRunId ?? (run.kind === "summary" ? run.sourceRunId : run.id);

    const summaryRunId = result?.summaryRunId ?? null;
    const summaryRun = summaryRunId ? this.db.getMeetingProcessingRun(summaryRunId) : null;

    return noteOutputSchema.parse({
      ...common,
      scope: "run",
      runId: run.id,
      run,
      result: result?.result ?? null,
      summaryProvenance: { source: "run-artifact", runIds: summaryRunId ? [summaryRunId] : [] },
      transcriptProvenance: {
        source: "run-artifact",
        runIds: transcriptRunId ? [transcriptRunId] : [],
      },
      summaryFreshness:
        result?.result.summary && summaryRun && transcriptRunId
          ? this.summaryFreshness(
              note,
              summaryRun,
              transcriptRunId,
              result.result.summary,
              result.result.speakerCorrectionRevision
            )
          : { status: "unknown", reasons: diagnostics },
      transcriptFreshness: {
        status: result?.result.transcript ? "current" : "unknown",
        reasons: result?.result.transcript ? [] : diagnostics,
      },
      diagnostics,
    });
  }

  private summaryFreshness(
    note: NoteRow,
    run: MeetingProcessingRunDto,
    sourceRunId: string,
    summary: MeetingSummaryArtifact,
    correctionRevision: number
  ): OutputFreshness {
    const revision = createHash("sha256")
      .update(
        JSON.stringify([
          note.content,
          note.title,
          note.participants,
          correctionRevision,
          run.config?.summary,
        ])
      )
      .digest("hex");

    return {
      ...this.compareSummarySource(note, run, sourceRunId, summary, correctionRevision),
      revision,
    };
  }

  private compareSummarySource(
    note: NoteRow,
    run: MeetingProcessingRunDto,
    sourceRunId: string,
    summary: MeetingSummaryArtifact,
    correctionRevision: number
  ): OutputFreshness {
    const reasons: string[] = [];

    if (
      summary.speakerCorrectionRevision !== undefined &&
      summary.speakerCorrectionRevision !== correctionRevision
    )
      reasons.push("speaker-corrections-changed");
    const raw = this.db.getMeetingRunLlmSourceSnapshot(run.id);
    let snapshot: ReturnType<typeof meetingLlmSourceSnapshotSchema.safeParse>;

    try {
      snapshot = meetingLlmSourceSnapshotSchema.safeParse(raw ? JSON.parse(raw) : null);
    } catch {
      return {
        status: reasons.length ? "stale" : "unknown",
        reasons: [...reasons, "generation-metadata-invalid"],
      };
    }

    if (!snapshot.success || snapshot.data.sourceRunId !== sourceRunId) {
      return {
        status: reasons.length ? "stale" : "unknown",
        reasons: [...reasons, "generation-metadata-unavailable"],
      };
    }

    const saved = snapshot.data;

    if (
      JSON.stringify(saved.sourceRecordingIds) !== JSON.stringify(meetingRunAudioPartIds(run)) ||
      (summary.manualNoteRevision !== undefined &&
        summary.manualNoteRevision !== saved.manualNoteRevision) ||
      saved.manualNoteRevision !==
        createHash("sha256").update(saved.manualNotes, "utf8").digest("hex")
    ) {
      return {
        status: reasons.length ? "stale" : "unknown",
        reasons: [...reasons, "generation-metadata-invalid"],
      };
    }

    if (
      saved.manualNoteRevision !== createHash("sha256").update(note.content, "utf8").digest("hex")
    )
      reasons.push("manual-notes-changed");

    if (saved.meetingTitle !== note.title) reasons.push("title-changed");
    let participantsKnown = saved.participants !== null;

    try {
      if (
        participantsKnown &&
        JSON.stringify(parseMeetingParticipants(note.participants)) !==
          JSON.stringify(saved.participants)
      )
        reasons.push("participants-changed");
    } catch {
      participantsKnown = false;
    }

    if (saved.speakerCorrectionRevision !== correctionRevision)
      reasons.push("speaker-corrections-changed");

    if (JSON.stringify(saved.promptModel) !== JSON.stringify(run.config?.summary))
      reasons.push("summary-config-changed");

    if (reasons.length) return { status: "stale", reasons: [...new Set(reasons)] };

    if (!participantsKnown || summary.speakerCorrectionRevision === undefined)
      return { status: "unknown", reasons: ["generation-metadata-incomplete"] };

    return { status: "current", reasons: [] };
  }

  list(scope: Scope & { withTranscript?: boolean } = {}) {
    return {
      notes: this.db
        .listAllNotes()
        .filter((note) => inScope(note, scope))
        .flatMap((note) => {
          const transcript = this.transcript(note.id);

          return !scope.withTranscript || transcript.text
            ? [this.metadata(note, transcript.status)]
            : [];
        }),
    };
  }

  private metadata(note: NoteRow, transcriptStatus: NoteTranscript["status"]) {
    return {
      id: note.id,
      title: note.title,
      created_at: localTimestamp(note.created_at),
      has_user_notes: note.content.length > 0,
      has_summary: Boolean(note.enhanced_content),
      transcript_status: transcriptStatus,
    };
  }

  show(note: NoteRow) {
    // SAFETY: participants are stored as a JSON array of contact references;
    // malformed JSON would have failed at write time.
    const participants = note.participants
      ? (JSON.parse(note.participants) as Array<{ email?: string; displayName?: string }>)
      : [];

    const spoken = this.transcript(note.id).speakers.filter(
      (speaker) => speaker.name || speaker.email
    );

    for (const speaker of spoken) {
      if (
        speaker.email &&
        participants.some((person) => person.email?.toLowerCase() === speaker.email?.toLowerCase())
      )
        continue;
      participants.push({
        email: speaker.email ?? undefined,
        displayName: speaker.name ?? undefined,
      });
    }

    return {
      note_id: note.id,
      title: note.title,
      created_at: localTimestamp(note.created_at),
      has_user_notes: note.content.length > 0,
      has_summary: Boolean(note.enhanced_content),
      transcript_status: this.transcript(note.id).status,
      participants: participants.map((person) => {
        const email = person.email?.trim() || null;
        const names = email ? this.db.getContactNames(email) : null;

        const stored_names = {
          display_name: names?.display_name ?? person.displayName ?? null,
          people_name: names?.people_name ?? null,
          learned_name: names?.learned_name ?? null,
        };

        return {
          name: stored_names.learned_name ?? stored_names.people_name ?? stored_names.display_name,
          email,
          stored_names,
        };
      }),
    };
  }

  content(note: NoteRow) {
    return { note_id: note.id, content: note.content };
  }

  summary(note: NoteRow) {
    return {
      note_id: note.id,
      status: note.enhanced_content ? "ready" : "absent",
      summary: note.enhanced_content || null,
    };
  }

  searchNotes(query: string, scope: Scope = {}) {
    const tokens = noteSearchTokens(query);

    return this.db
      .listAllNotes()
      .filter((note) => inScope(note, scope))
      .flatMap((note) => {
        const fields = [
          ["title", note.title],
          ["user_notes", note.content],
          ["summary", note.enhanced_content ?? ""],
        ] as const;

        const found = fields
          .filter(([, text]) => matches(text, tokens))
          .map(([source, text]) => ({ source, snippet: snippet(text, tokens) }));

        return found.length ? [{ note_id: note.id, title: note.title, matches: found }] : [];
      });
  }

  searchTranscripts(query: string, scope: Scope = {}) {
    const tokens = noteSearchTokens(query);

    return this.db
      .listAllNotes()
      .filter((note) => inScope(note, scope))
      .flatMap((note) => {
        const transcript = this.transcript(note.id);
        const speakers = new Map(transcript.speakers.map((speaker) => [speaker.id, speaker.name]));

        const segments =
          transcript.segments ??
          (transcript.text
            ? [{ speaker_id: null, start_ms: null, end_ms: null, text: transcript.text }]
            : []);

        const found = segments
          .filter((segment) => matches(segment.text, tokens))
          .map((segment) => ({
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            speaker_id: segment.speaker_id,
            speaker_name: segment.speaker_id ? (speakers.get(segment.speaker_id) ?? null) : null,
            snippet: snippet(segment.text, tokens),
          }));

        return found.length ? [{ note_id: note.id, title: note.title, matches: found }] : [];
      });
  }

  search(query: string, scope: Scope = {}) {
    return {
      query,
      notes: this.searchNotes(query, scope),
      transcripts: this.searchTranscripts(query, scope),
    };
  }
}
