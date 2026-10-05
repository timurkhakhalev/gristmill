import {
  computePcm16Rms,
  MEETING_MIC_ACTIVITY_RMS,
  MEETING_SYSTEM_ACTIVITY_RMS,
  type MeetingAudioSource,
} from "../utils/audioUtils.js";

// How long a channel stays "active" after its last audible chunk. Both tails sit
// in front of the auto-end dwell, so they are kept short; the system tail only
// has to bridge the pause between a remote speaker's words, not their sentences.
export const MIC_ACTIVITY_TAIL_MS = 2_000;

export const SYSTEM_ACTIVITY_TAIL_MS = 1_000;

const CHANNELS = {
  mic: { threshold: MEETING_MIC_ACTIVITY_RMS, tailMs: MIC_ACTIVITY_TAIL_MS },
  system: { threshold: MEETING_SYSTEM_ACTIVITY_RMS, tailMs: SYSTEM_ACTIVITY_TAIL_MS },
} satisfies Record<MeetingAudioSource, { threshold: number; tailMs: number }>;

const SOURCES: readonly MeetingAudioSource[] = ["mic", "system"];

export interface MeetingAudioActivityState {
  micActive: boolean;
  systemActive: boolean;
}

export interface MeetingAudioActivityMonitor {
  recordChunk(source: MeetingAudioSource, buffer: Buffer | null | undefined): void;
  tick(nowMs: number): void;
  reset(): void;
  getState(): MeetingAudioActivityState;
}

export interface MeetingAudioActivityMonitorOptions {
  onActivityChanged?: (state: MeetingAudioActivityState) => void;
}

// Energy-based activity per meeting channel. Timer-free: the owner feeds every
// PCM chunk through recordChunk() and drives evaluation with a ~1s tick().
// Activity is judged from sample energy, never from chunk arrival — the
// Windows loopback helper streams digital-zero silence continuously.
export const createMeetingAudioActivityMonitor = ({
  onActivityChanged = () => {},
}: MeetingAudioActivityMonitorOptions = {}): MeetingAudioActivityMonitor => {
  const pending: Record<MeetingAudioSource, boolean> = { mic: false, system: false };
  const lastActiveAt: Record<MeetingAudioSource, number | null> = { mic: null, system: null };
  const active: Record<MeetingAudioSource, boolean> = { mic: false, system: false };

  const getState = (): MeetingAudioActivityState => ({
    micActive: active.mic,
    systemActive: active.system,
  });

  const reset = () => {
    for (const source of SOURCES) {
      pending[source] = false;
      lastActiveAt[source] = null;
      active[source] = false;
    }
  };

  // Hot path — runs for every chunk of both channels. Once a chunk in the
  // current tick has crossed the threshold there is nothing left to learn, so
  // the RMS pass is skipped until the next tick clears the flag.
  const recordChunk = (source: MeetingAudioSource, buffer: Buffer | null | undefined) => {
    const channel = CHANNELS[source];

    if (!channel || pending[source]) return;
    pending[source] = computePcm16Rms(buffer) >= channel.threshold;
  };

  const tick = (nowMs: number) => {
    let changed = false;

    for (const source of SOURCES) {
      const channel = CHANNELS[source];

      if (pending[source]) {
        pending[source] = false;
        lastActiveAt[source] = nowMs;
      }

      const nextActive =
        lastActiveAt[source] !== null && nowMs - lastActiveAt[source] < channel.tailMs;

      if (nextActive !== active[source]) {
        active[source] = nextActive;
        changed = true;
      }
    }

    if (changed) onActivityChanged(getState());
  };

  return { recordChunk, tick, reset, getState };
};
