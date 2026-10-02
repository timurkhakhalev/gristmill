import type { MeetingCaptureStopRequest } from "../contracts/meetingCoordinator.js";
import type { WebContents } from "electron";

export interface MeetingTranscriptionSessionOptions {
  [key: string]: unknown;
}

export interface MeetingStartInvocation {
  sessionId: string;
  ownerWebContents: WebContents | null;
  options: MeetingTranscriptionSessionOptions;
}

export interface MeetingStartResult {
  success?: boolean;
  error?: string;
  reason?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface MeetingStopResult {
  success: boolean;
  captureState?: "ready" | "incomplete";
  recordingId?: string;
  initialRunId?: string;
  reason?: string;
  transcript?: string;
  diarizationSessionId?: string;
  error?: string;
}

export interface MeetingLifecycleSession {
  sessionId: string;
  ownerWebContents: WebContents | null;
  state: "queued" | "starting" | "active" | "stopping";
  startSucceeded: boolean;
  stopRequested: boolean;
  incomplete: boolean;
  microphoneBoundary?: MeetingCaptureStopRequest["microphoneBoundary"];
  pause?: boolean;
  lastSequence?: Partial<Record<"mic" | "system", number>>;
  errorCode?: string;
  suppressProcessing: boolean;
  stopPromise: Promise<MeetingStopResult> | null;
  ownerLossHandler: (() => void) | null;
  ownerNavigationHandler: ((details: { isMainFrame?: boolean; isSameDocument?: boolean }) => void) | null;
}

export interface MeetingTranscriptionLifecycle {
  startSession(input: {
    sessionId: string;
    ownerWebContents: WebContents | null;
    options: MeetingTranscriptionSessionOptions;
  }): Promise<MeetingStartResult>;
  stopSession(
    expectedSessionId?: string | null,
    options?: {
      incomplete?: boolean;
      microphoneBoundary?: MeetingCaptureStopRequest["microphoneBoundary"];
      pause?: boolean;
      lastSequence?: Partial<Record<"mic" | "system", number>>;
      errorCode?: string;
      suppressProcessing?: boolean;
    }
  ): Promise<MeetingStopResult>;
}

export function createMeetingTranscriptionLifecycle({
  start,
  stop,
  onError = () => {},
}: {
  start: (invocation: MeetingStartInvocation) => Promise<MeetingStartResult>;
  stop: (
    sessionId: string,
    options?: {
      incomplete?: boolean;
      microphoneBoundary?: MeetingCaptureStopRequest["microphoneBoundary"];
      pause?: boolean;
      lastSequence?: Partial<Record<"mic" | "system", number>>;
      errorCode?: string;
      suppressProcessing?: boolean;
    }
  ) => Promise<MeetingStopResult>;
  onError?: (error: unknown, sessionId: string) => void;
}): MeetingTranscriptionLifecycle {
  let operationTail: Promise<unknown> = Promise.resolve();
  const sessions = new Map<string, MeetingLifecycleSession>();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = operationTail.then(operation, operation);
    operationTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  };

  const detachOwnerListeners = (session: MeetingLifecycleSession): void => {
    if (!session.ownerLossHandler) return;

    session.ownerWebContents?.removeListener?.("destroyed", session.ownerLossHandler);
    session.ownerWebContents?.removeListener?.("render-process-gone", session.ownerLossHandler);
    session.ownerWebContents?.removeListener?.(
      "did-start-navigation",
      // The navigation handler takes details; removeListener only compares
      // identity, so passing it as the stored handler reference is safe.
      session.ownerNavigationHandler as unknown as () => void
    );
    session.ownerLossHandler = null;
    session.ownerNavigationHandler = null;
  };

  const removeSession = (session: MeetingLifecycleSession): void => {
    detachOwnerListeners(session);
    if (sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }
  };

  const resolveSession = (expectedSessionId?: string | null): MeetingLifecycleSession | null => {
    if (expectedSessionId != null) return sessions.get(expectedSessionId) ?? null;
    return sessions.values().next().value ?? null;
  };

  const stopSession = (
    expectedSessionId?: string | null,
    options: {
      incomplete?: boolean;
      microphoneBoundary?: MeetingCaptureStopRequest["microphoneBoundary"];
      pause?: boolean;
      lastSequence?: Partial<Record<"mic" | "system", number>>;
      errorCode?: string;
      suppressProcessing?: boolean;
    } = {}
  ): Promise<MeetingStopResult> => {
    const session = resolveSession(expectedSessionId);
    if (!session) {
      return Promise.resolve({ success: false, reason: "stale-session" });
    }
    if (session.stopPromise) {
      session.incomplete ||= options.incomplete === true;
      session.lastSequence ??= options.lastSequence;
      session.microphoneBoundary ??= options.microphoneBoundary;
      session.pause ||= options.pause === true;
      session.errorCode ??= options.errorCode;
      session.suppressProcessing ||= options.suppressProcessing === true;
      return session.stopPromise;
    }

    session.stopRequested = true;
    session.incomplete = options.incomplete === true;
    session.lastSequence = options.lastSequence;
    session.microphoneBoundary = options.microphoneBoundary;
    session.pause = options.pause === true;
    session.errorCode = options.errorCode;
    session.suppressProcessing = options.suppressProcessing === true;
    session.state = "stopping";
    session.stopPromise = enqueue(async () => {
      try {
        if (!session.startSucceeded) return { success: true };
        return await stop(session.sessionId, {
          incomplete: session.incomplete,
          lastSequence: session.lastSequence,
          ...(session.microphoneBoundary ? { microphoneBoundary: session.microphoneBoundary } : {}),
          ...(session.pause ? { pause: true } : {}),
          errorCode: session.errorCode,
          suppressProcessing: session.suppressProcessing,
        });
      } finally {
        removeSession(session);
      }
    });
    return session.stopPromise;
  };

  const startSession = ({
    sessionId,
    ownerWebContents,
    options,
  }: {
    sessionId: string;
    ownerWebContents: WebContents | null;
    options: MeetingTranscriptionSessionOptions;
  }): Promise<MeetingStartResult> => {
    // A renderer that reloads mid-recording forgets its session while this side
    // keeps capturing. The same owner asking to start again can only mean that,
    // so retire its stale sessions instead of refusing every start until restart.
    for (const session of sessions.values()) {
      if (
        ownerWebContents &&
        session.ownerWebContents === ownerWebContents &&
        session.state !== "stopping"
      ) {
        void stopSession(session.sessionId, { incomplete: true }).catch((error) =>
          onError(error, session.sessionId)
        );
      }
    }
    const operationInProgress = [...sessions.values()].some(
      (session) => session.state !== "stopping"
    );
    if (operationInProgress || sessions.has(sessionId)) {
      return Promise.resolve({ success: false, error: "Operation in progress" });
    }

    const session: MeetingLifecycleSession = {
      sessionId,
      ownerWebContents,
      state: "queued",
      startSucceeded: false,
      stopRequested: false,
      stopPromise: null,
      incomplete: false,
      lastSequence: undefined,
      errorCode: undefined,
      suppressProcessing: false,
      ownerLossHandler: null,
      ownerNavigationHandler: null,
    };
    sessions.set(sessionId, session);

    const startPromise = enqueue(async () => {
      if (session.stopRequested) {
        removeSession(session);
        return { success: false, error: "Start canceled", reason: "canceled", sessionId };
      }

      session.state = "starting";
      try {
        const result = await start({ sessionId, ownerWebContents, options });
        session.startSucceeded = result?.success === true;
        if (!session.startSucceeded) {
          removeSession(session);
        } else if (!session.stopRequested) {
          session.state = "active";
        }
        return result;
      } catch (error) {
        removeSession(session);
        throw error;
      }
    });

    const handleOwnerLoss = () => {
      void stopSession(sessionId, { incomplete: true }).catch((error) => {
        onError(error, sessionId);
      });
    };
    // A main-frame navigation (reload, onboarding restart) replaces the renderer
    // that owns the session, so it counts as owner loss too.
    const handleOwnerNavigation = (details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (!details?.isMainFrame || details?.isSameDocument) return;
      handleOwnerLoss();
    };
    session.ownerLossHandler = handleOwnerLoss;
    session.ownerNavigationHandler = handleOwnerNavigation;
    ownerWebContents?.once?.("destroyed", handleOwnerLoss);
    ownerWebContents?.once?.("render-process-gone", handleOwnerLoss);
    ownerWebContents?.on?.("did-start-navigation", handleOwnerNavigation);

    if (ownerWebContents?.isDestroyed?.()) {
      handleOwnerLoss();
    }

    return startPromise;
  };

  return { startSession, stopSession };
}

module.exports = createMeetingTranscriptionLifecycle;
module.exports.createMeetingTranscriptionLifecycle = createMeetingTranscriptionLifecycle;
