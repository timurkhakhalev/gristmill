export const SPEAKER_STATUS = Object.freeze({
  PROVISIONAL: "provisional",
  CONFIRMED: "confirmed",
  SUGGESTED: "suggested",
  LOCKED: "locked",
} as const);

export type SpeakerStatusValue = (typeof SPEAKER_STATUS)[keyof typeof SPEAKER_STATUS];

export interface SpeakerSegment {
  speaker?: string | null;
  speakerName?: string | null;
  speakerIsPlaceholder?: boolean;
  speakerStatus?: string;
  speakerLocked?: boolean;
  speakerLockSource?: string | null;
  suggestedName?: string | null;
  suggestedProfileId?: number | null;
  text?: string | null;
  timestamp?: number | null;
  [key: string]: string | number | boolean | null | undefined;
}

export function canonicalizeSpeakerStatus(
  status: string | null | undefined,
  segment: SpeakerSegment | null = null
): SpeakerStatusValue | undefined {
  if (segment?.speakerLocked || segment?.speakerLockSource === "user") {
    return SPEAKER_STATUS.LOCKED;
  }

  switch (status) {
    case SPEAKER_STATUS.PROVISIONAL:
    case SPEAKER_STATUS.CONFIRMED:
    case SPEAKER_STATUS.SUGGESTED:
    case SPEAKER_STATUS.LOCKED:
      return status;
    case "user_locked":
      return SPEAKER_STATUS.LOCKED;
    case "suggested_profile":
      return SPEAKER_STATUS.SUGGESTED;
    case "uncertain_overlap":
      return SPEAKER_STATUS.PROVISIONAL;
    default:
      return undefined;
  }
}

export function isSpeakerLocked(segment: SpeakerSegment | null | undefined): boolean {
  return (
    canonicalizeSpeakerStatus(segment?.speakerStatus, segment ?? null) === SPEAKER_STATUS.LOCKED
  );
}

export function canAutoRelabelSpeaker(segment: SpeakerSegment | null | undefined): boolean {
  return !isSpeakerLocked(segment);
}

function applySpeakerUpdate<T extends SpeakerSegment>(
  segment: T,
  patch: Partial<T>,
  status: SpeakerStatusValue
): T {
  if (isSpeakerLocked(segment)) {
    segment.speakerStatus = SPEAKER_STATUS.LOCKED;
    segment.speakerLocked = true;
    segment.speakerLockSource = segment.speakerLockSource || "user";

    return segment;
  }

  Object.assign(segment, patch);

  segment.speakerStatus = status;

  return segment;
}

export function applyProvisionalSpeaker<T extends SpeakerSegment>(
  segment: T,
  patch: Partial<T> = {}
): T {
  return applySpeakerUpdate(segment, patch, SPEAKER_STATUS.PROVISIONAL);
}

export function applyConfirmedSpeaker<T extends SpeakerSegment>(
  segment: T,
  patch: Partial<T> = {}
): T {
  return applySpeakerUpdate(segment, patch, SPEAKER_STATUS.CONFIRMED);
}

export function applySuggestedSpeaker<T extends SpeakerSegment>(
  segment: T,
  patch: Partial<T> = {}
): T {
  if (isSpeakerLocked(segment)) {
    return segment;
  }

  return applySpeakerUpdate(segment, patch, SPEAKER_STATUS.SUGGESTED);
}
