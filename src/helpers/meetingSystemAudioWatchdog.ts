// The macOS tap helper writes a chunk every period whatever the audio is, so a
// gap this long means delivery stopped rather than the call going quiet.
export const STALL_MS = 6_000;

// Chunks still arriving but silent for this long, after the call was audible at
// least once. Warning only: a genuinely quiet call looks exactly the same.
export const GONE_QUIET_MS = 180_000;

// Consecutive attempts without recovered delivery, not a lifetime meeting limit.
export const MAX_RESTARTS = 3;

// If all quick attempts fail, keep checking without depending on a device
// notification from a helper that may have exited.
export const RECOVERY_RETRY_MS = 30_000;

// A tick gap longer than this means the machine slept or the main process
// blocked. Delivery evidence from before the gap says nothing about now, and
// node runs the timers phase before the poll phase, so the tick after a block
// lands before the stdout data it should have been judging.
export const TICK_GAP_MS = 5_000;

export type SystemAudioInterruptionReason =
  | "device_invalidated"
  | "no_audio_delivered"
  | "gone_quiet";

export interface SystemAudioInterruption {
  systemAudioStrategy: string | null;
  reason: SystemAudioInterruptionReason;
  recovering: boolean;
}

export interface MeetingSystemAudioCapture {
  generation: number;
  stop(): Promise<void>;
  start(): Promise<void>;
}

interface MeetingSystemAudioWatchdogSession {
  systemAudioStrategy: string | null;
  watchesDelivery: boolean;
  deliveryStartedAt: number | null;
  lastChunkAt: number | null;
  lastAudibleAt: number | null;
  restarts: number;
  restartInFlight: boolean;
  replacementStarting: boolean;
  pendingDeviceInvalidation: boolean;
  recoveryFailed: boolean;
  quietReported: boolean;
  interruptionReported: boolean;
  retryAt: number;
}

export interface MeetingSystemAudioWatchdogOptions {
  now?: () => number;
  onInterrupted?: (payload: SystemAudioInterruption) => void;
  onResumed?: () => void;
}

export interface MeetingSystemAudioWatchdog {
  start(options?: { systemAudioStrategy?: string | null; watchesDelivery?: boolean }): void;
  stop(): void;
  attachCapture(capture: Pick<MeetingSystemAudioCapture, "stop" | "start">): void;
  detachCapture(): void;
  recordStarted(): void;
  recordChunk(audible?: boolean): void;
  reportDeviceInvalidated(): void;
  reportCaptureFailed(): void;
  tick(): void;
}

// The system-audio tap is built once and never follows the machine afterwards,
// so a route change or a disappearing device can stop capture with the helper
// process still alive and the UI still showing a live recording. Nothing else
// notices: the helper does not exit, and silence is indistinguishable from a
// quiet call, which is what made the original meeting regression invisible mid-call.
//
// Two triggers are trusted enough to restart capture:
//
//   delivery: no chunk at all for STALL_MS. Only meaningful where the platform
//     guarantees a chunk per period (the macOS tap); the loopback helpers may
//     legitimately go idle, so the caller opts in via watchesDelivery.
//   device: the helper reported that the device it was pinned to changed or
//     went away. Decisive, and faster than waiting for the stall window.
//
// Going quiet is reported but never restarts anything, because restarting a
// working capture costs real audio and a silent call is not a fault.
//
// Tick-driven like meetingAutoEndController: every input updates state and the
// owner calls tick() on an interval, so there is no timer to leak per session.
export const createMeetingSystemAudioWatchdog = ({
  now = Date.now,
  onInterrupted,
  onResumed,
}: MeetingSystemAudioWatchdogOptions): MeetingSystemAudioWatchdog => {
  let session: MeetingSystemAudioWatchdogSession | null = null;
  let capture: MeetingSystemAudioCapture | null = null;
  // Bumped on every attach and detach. A restart suspended between its two
  // halves compares against the value it started with, so a meeting that ends
  // mid-restart cannot leave an orphan helper holding a process tap.
  let generation = 0;
  let lastTickAt: number | null = null;

  const notify = (
    active: MeetingSystemAudioWatchdogSession,
    reason: SystemAudioInterruptionReason,
    recovering: boolean
  ) => {
    onInterrupted?.({
      systemAudioStrategy: active.systemAudioStrategy,
      reason,
      recovering,
    });
  };

  // Capture is attached when it starts, which happens before the session is
  // armed. start() must therefore never drop it, and detaching is teardown's
  // job alone: an earlier draft cleared it from the arming path and shipped a
  // watchdog that warned about stalls it could not actually recover from.
  const attachCapture = ({ stop, start }: Pick<MeetingSystemAudioCapture, "stop" | "start">) => {
    generation += 1;
    capture = { generation, stop, start };
  };

  const detachCapture = () => {
    generation += 1;
    capture = null;
  };

  const runRestart = async (active: MeetingSystemAudioWatchdogSession): Promise<void> => {
    if (!capture) {
      return;
    }

    const target = capture;
    await target.stop().catch(() => {});

    if (generation !== target.generation || session !== active) {
      return;
    }

    active.replacementStarting = true;
    await target.start();

    if (generation !== target.generation) {
      // The session ended while the helper was coming back up.
      await target.stop().catch(() => {});
    }
  };

  const requestRestart = (reason: Exclude<SystemAudioInterruptionReason, "gone_quiet">): void => {
    if (!session) {
      return;
    }

    if (session.recoveryFailed) {
      if (now() < session.retryAt) return;
      // One slow attempt, keeping the existing failure notice until PCM returns.
      session.restarts = MAX_RESTARTS - 1;
      session.retryAt = now() + RECOVERY_RETRY_MS;
    }

    if (session.restartInFlight) {
      // Ignore the retiring helper, but retain a warning from its replacement:
      // its start acknowledgement and warning can share the same stderr read.
      if (reason === "device_invalidated" && session.replacementStarting) {
        session.pendingDeviceInvalidation = true;
      }

      return;
    }

    if (session.restarts >= MAX_RESTARTS) {
      // After the quick attempts, retry slowly even if the helper has exited
      // and can no longer report that the route changed.
      session.recoveryFailed = true;
      session.quietReported = true;
      session.retryAt = now() + RECOVERY_RETRY_MS;
      notify(session, reason, false);

      return;
    }

    const active = session;
    active.restarts += 1;
    active.restartInFlight = true;
    active.interruptionReported = true;

    if (!active.recoveryFailed) notify(active, reason, true);

    Promise.resolve()
      .then(() => runRestart(active))
      .catch(() => {})
      .finally(() => {
        if (session !== active) {
          return;
        }

        active.restartInFlight = false;
        active.replacementStarting = false;
        // Give the fresh capture a clean window even if the restart threw; the
        // next tick judges it on its own evidence either way.
        const at = now();
        active.deliveryStartedAt = at;
        active.lastChunkAt = null;

        if (active.lastAudibleAt !== null) {
          active.lastAudibleAt = at;
        }

        if (active.pendingDeviceInvalidation) {
          active.pendingDeviceInvalidation = false;
          requestRestart("device_invalidated");
        }
      });
  };

  const start = ({
    systemAudioStrategy,
    watchesDelivery = false,
  }: { systemAudioStrategy?: string | null; watchesDelivery?: boolean } = {}) => {
    lastTickAt = null;
    session = {
      systemAudioStrategy: systemAudioStrategy ?? null,
      watchesDelivery: watchesDelivery === true,
      // A start ACK arms the first-delivery deadline. Before that ACK,
      // slow startup has no delivery obligation.
      deliveryStartedAt: null,
      lastChunkAt: null,
      lastAudibleAt: null,
      restarts: 0,
      restartInFlight: false,
      replacementStarting: false,
      pendingDeviceInvalidation: false,
      recoveryFailed: false,
      quietReported: false,
      interruptionReported: false,
      retryAt: 0,
    };
  };

  const stop = () => {
    session = null;
    lastTickAt = null;
    detachCapture();
  };

  const recordStarted = () => {
    if (!session) return;
    session.deliveryStartedAt = now();
    session.lastChunkAt = null;
  };

  const recordChunk = (audible = false) => {
    if (!session) {
      return;
    }

    const at = now();
    session.lastChunkAt = at;

    // stop() flushes the retiring helper's tail. Only delivery after the
    // replacement has started proves that recovery worked.
    if (!session.restartInFlight) {
      session.restarts = 0;
      session.recoveryFailed = false;

      if (session.interruptionReported) {
        session.interruptionReported = false;
        session.quietReported = false;
        onResumed?.();
      }
    }

    if (audible) {
      session.lastAudibleAt = at;

      if (session.quietReported && !session.recoveryFailed) {
        session.quietReported = false;
        onResumed?.();
      }
    }
  };

  const reportDeviceInvalidated = () => {
    if (session?.recoveryFailed) {
      session.recoveryFailed = false;
      session.restarts = 0;
    }

    requestRestart("device_invalidated");
  };

  // Rebases the delivery evidence across a gap the session did not really live
  // through, so waking from sleep does not read as a dead tap.
  const observeClock = () => {
    const at = now();
    const gap = lastTickAt === null ? 0 : at - lastTickAt;
    lastTickAt = at;

    if (gap > TICK_GAP_MS && session) {
      if (session.deliveryStartedAt !== null) session.deliveryStartedAt = at;

      if (session.lastChunkAt !== null) {
        session.lastChunkAt = at;
      }

      if (session.lastAudibleAt !== null) {
        session.lastAudibleAt = at;
      }
    }

    return at;
  };

  const tick = () => {
    const at = observeClock();

    if (!session || session.restartInFlight) {
      return;
    }

    const deliveryAt = session.lastChunkAt ?? session.deliveryStartedAt;

    if (session.watchesDelivery && deliveryAt !== null && at - deliveryAt > STALL_MS) {
      requestRestart("no_audio_delivered");

      return;
    }

    if (
      !session.quietReported &&
      session.lastAudibleAt !== null &&
      at - session.lastAudibleAt > GONE_QUIET_MS
    ) {
      session.quietReported = true;
      notify(session, "gone_quiet", false);
    }
  };

  return {
    start,
    stop,
    attachCapture,
    detachCapture,
    recordStarted,
    recordChunk,
    reportDeviceInvalidated,
    reportCaptureFailed: () => requestRestart("no_audio_delivered"),
    tick,
  };
};

module.exports = createMeetingSystemAudioWatchdog;

// CommonJS contract for legacy require sites; each named export mirrors the
// local constant so destructuring requires stay typed.
Object.assign(module.exports, {
  createMeetingSystemAudioWatchdog,
  STALL_MS,
  GONE_QUIET_MS,
  MAX_RESTARTS,
  RECOVERY_RETRY_MS,
  TICK_GAP_MS,
});
