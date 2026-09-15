/**
 * Pure input-selection policy for post-meeting diarization.
 *
 * A meeting session records two parallel raw PCM captures: the system-audio
 * tap (calls) and the microphone (in-person sessions, kept only until system
 * audio turns audible). At stop, exactly one of them feeds the diarizer and
 * the other is deleted. Call sessions keep today's behavior: any session that
 * heard audible system audio diarizes the system channel.
 */
import type { MeetingAudioSource } from "../utils/audioUtils.js";

export interface DiarizationInputOptions {
  systemPcmPath?: string | null;
  micPcmPath?: string | null;
  systemAudioHeard?: boolean;
  systemStartedAt?: number | null;
  micStartedAt?: number | null;
}

export interface DiarizationInput {
  pcmPath: string | null;
  startedAt: number | null;
  diarizedSource: MeetingAudioSource;
  cleanupPcmPaths: string[];
}

export function resolveDiarizationInput({
  systemPcmPath = null,
  micPcmPath = null,
  systemAudioHeard = false,
  systemStartedAt = null,
  micStartedAt = null,
}: DiarizationInputOptions = {}): DiarizationInput {
  if (systemAudioHeard || !micPcmPath) {
    return {
      pcmPath: systemPcmPath,
      startedAt: systemStartedAt,
      diarizedSource: "system",
      cleanupPcmPaths: micPcmPath ? [micPcmPath] : [],
    };
  }

  return {
    pcmPath: micPcmPath,
    startedAt: micStartedAt,
    diarizedSource: "mic",
    cleanupPcmPaths: systemPcmPath ? [systemPcmPath] : [],
  };
}
