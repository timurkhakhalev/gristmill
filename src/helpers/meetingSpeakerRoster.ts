// Participant projections used by capture metadata and speaker profile auto-labeling.
import { parseNoteParticipants } from "../utils/noteParticipants.js";
import type { NoteParticipant } from "../contracts/contactIdentity.js";
import { normalizeStoredSpeakerCount } from "./speakerCount.js";
import speakerDetection from "../constants/speakerDetection.json";

export const DEFAULT_EXPECTED_SPEAKER_COUNT: number =
  speakerDetection.DEFAULT_EXPECTED_SPEAKER_COUNT;

export const MAX_SPEAKER_COUNT: number = speakerDetection.MAX_SPEAKER_COUNT;

export interface MeetingSpeakerRosterDatabase {
  getNote(noteId: number): MeetingSpeakerRosterNote | null;
  getGoogleAccounts(): Array<{ email?: string | null }>;
}

export interface MeetingSpeakerRosterNote {
  id?: number;
  folder_id?: number | null;
  participants?: string | null;
  diarization_enabled?: number | boolean | null;
  expected_speaker_count?: unknown;
}

export interface MeetingSessionSpeakerConfig {
  enabled: boolean;
  expectedCount: number;
  explicit?: boolean;
}

function parseNonSelfParticipants(
  deps: { databaseManager: MeetingSpeakerRosterDatabase },
  participantsJson: string | null | undefined
): NoteParticipant[] {
  const googleEmails = new Set(
    deps.databaseManager
      .getGoogleAccounts()
      .map((account) => account.email?.toLowerCase())
      .filter(Boolean)
  );

  return parseNoteParticipants(participantsJson ?? null).filter(
    (person) => !person.self && (!person.email || !googleEmails.has(person.email.toLowerCase()))
  );
}

export function resolveOneOnOneOtherParticipant(
  deps: { databaseManager: MeetingSpeakerRosterDatabase },
  participantsJson: string | null | undefined
): { displayName: string; contactId: number } | null {
  const others = parseNonSelfParticipants(deps, participantsJson);

  if (others.length !== 1) return null;
  const displayName = others[0].displayName || others[0].email;

  if (!displayName) return null;

  return { displayName, contactId: others[0].contactId };
}

export function noteExpectedSpeakerCountOrNull(
  deps: { databaseManager: MeetingSpeakerRosterDatabase },
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
