import type { DatabaseManager, NoteRow } from "./database.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";
import { meetingTranscriptArtifactSchema } from "../contracts/meetingRecording.js";
import { filterNoteTranscript, readNoteTranscript } from "./noteTranscriptReader.js";
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
  return (scope.note === undefined || scope.note === note.id) &&
    (scope.from === undefined || date >= scope.from) &&
    (scope.to === undefined || date <= scope.to);
}

function matches(text: string, tokens: string[]): boolean {
  const words = noteSearchTokens(text).map((word) => word.toLocaleLowerCase());
  return tokens.length > 0 && tokens.every((token) => words.some((word) => word.startsWith(token.toLocaleLowerCase())));
}

function snippet(text: string, tokens: string[]): string {
  const words = [...text.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)];
  const first = words.find((word) => tokens.some((token) => word[0].toLocaleLowerCase().startsWith(token.toLocaleLowerCase())));
  const at = first?.index ?? 0;
  return text.slice(Math.max(0, at - 60), Math.min(text.length, at + 160)).replace(/\s+/g, " ").trim();
}

export class NoteReadService {
  constructor(private readonly db: DatabaseManager, private readonly storage: MeetingRecordingStorage) {}

  transcript(noteId: number, filter: TranscriptFilter = {}): NoteTranscript {
    const transcript = readNoteTranscript({
      listRecordings: (id) => this.db.listMeetingRecordingsForNote(id),
      listEpochs: (id) => this.db.listMeetingRecordingEpochs(id),
      getRun: (id) => this.db.getMeetingProcessingRun(id),
      readTranscript: (id) => {
        const artifact = this.storage.readRunArtifact(id, "transcript");
        if (artifact === null) return null;
        return meetingTranscriptArtifactSchema.parse(artifact);
      },
      getCorrections: (id) => this.db.getMeetingRunSpeakerCorrections(id),
      profileEmail: (id) => this.db.getSpeakerProfiles().find((profile) => profile.id === id)?.email ?? null,
      getProjection: (id) => this.db.getNote(id)?.transcript ?? null,
    }, noteId);
    return filterNoteTranscript(transcript, filter);
  }

  list(scope: Scope & { withTranscript?: boolean } = {}) {
    return { notes: this.db.listAllNotes().filter((note) => inScope(note, scope)).flatMap((note) => {
      const transcript = this.transcript(note.id);
      return !scope.withTranscript || transcript.text ? [this.metadata(note, transcript.status)] : [];
    }) };
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
    const participants = note.participants ? JSON.parse(note.participants) as Array<{ email?: string; displayName?: string }> : [];
    const spoken = this.transcript(note.id).speakers.filter((speaker) => speaker.name || speaker.email);
    for (const speaker of spoken) {
      if (speaker.email && participants.some((person) => person.email?.toLowerCase() === speaker.email?.toLowerCase())) continue;
      participants.push({ email: speaker.email ?? undefined, displayName: speaker.name ?? undefined });
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
        return { name: stored_names.learned_name ?? stored_names.people_name ?? stored_names.display_name, email, stored_names };
      }),
    };
  }

  content(note: NoteRow) { return { note_id: note.id, content: note.content }; }

  summary(note: NoteRow) {
    return { note_id: note.id, status: note.enhanced_content ? "ready" : "absent", summary: note.enhanced_content || null };
  }

  searchNotes(query: string, scope: Scope = {}) {
    const tokens = noteSearchTokens(query);
    return this.db.listAllNotes().filter((note) => inScope(note, scope)).flatMap((note) => {
      const fields = [
        ["title", note.title], ["user_notes", note.content], ["summary", note.enhanced_content ?? ""],
      ] as const;
      const found = fields.filter(([, text]) => matches(text, tokens))
        .map(([source, text]) => ({ source, snippet: snippet(text, tokens) }));
      return found.length ? [{ note_id: note.id, title: note.title, matches: found }] : [];
    });
  }

  searchTranscripts(query: string, scope: Scope = {}) {
    const tokens = noteSearchTokens(query);
    return this.db.listAllNotes().filter((note) => inScope(note, scope)).flatMap((note) => {
      const transcript = this.transcript(note.id);
      const speakers = new Map(transcript.speakers.map((speaker) => [speaker.id, speaker.name]));
      const segments = transcript.segments ?? (transcript.text ? [{ speaker_id: null, start_ms: null, end_ms: null, text: transcript.text }] : []);
      const found = segments.filter((segment) => matches(segment.text, tokens)).map((segment) => ({
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        speaker_id: segment.speaker_id,
        speaker_name: segment.speaker_id ? speakers.get(segment.speaker_id) ?? null : null,
        snippet: snippet(segment.text, tokens),
      }));
      return found.length ? [{ note_id: note.id, title: note.title, matches: found }] : [];
    });
  }

  search(query: string, scope: Scope = {}) {
    return { query, notes: this.searchNotes(query, scope), transcripts: this.searchTranscripts(query, scope) };
  }
}
