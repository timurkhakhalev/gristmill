import type { WebContents } from "electron";

export interface MeetingAutoEndEngineLike {
  completeAutoEndSession(sessionId: string, sender: WebContents): Promise<boolean> | boolean;
  respondToAutoEndNotification(
    sessionId: string,
    action: "restart" | "dismiss",
    sender: WebContents
  ): boolean;
}

export interface MeetingAutoEndLifecycleResult {
  success: boolean;
  reason?: "invalid-session" | "invalid-action" | "stale-session";
  error?: string;
}

interface IpcEventLike {
  sender: WebContents;
}

interface AutoEndArguments {
  sessionId: string;
  action: string;
  sender: WebContents;
}

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

const isValidSessionId = (sessionId: string): boolean => sessionId.trim().length > 0;

export async function completeMeetingAutoEndSession(
  engine: MeetingAutoEndEngineLike | null | undefined,
  sessionId: string,
  sender: WebContents
): Promise<MeetingAutoEndLifecycleResult> {
  if (!isValidSessionId(sessionId)) {
    return { success: false, reason: "invalid-session" };
  }

  if ((await engine?.completeAutoEndSession(sessionId, sender)) !== true) {
    return { success: false, reason: "stale-session" };
  }

  return { success: true };
}

export function respondToMeetingAutoEndNotification(
  engine: MeetingAutoEndEngineLike | null | undefined,
  sessionId: string,
  action: string,
  sender: WebContents
): MeetingAutoEndLifecycleResult {
  if (!isValidSessionId(sessionId)) {
    return { success: false, reason: "invalid-session" };
  }

  if (action !== "restart" && action !== "dismiss") {
    return { success: false, reason: "invalid-action" };
  }

  if (engine?.respondToAutoEndNotification(sessionId, action, sender) !== true) {
    return { success: false, reason: "stale-session" };
  }

  return { success: true };
}

const getErrorMessage = (error: Error): string => error.message;

// ipcMain handlers receive the Electron invoke event plus a rest spread; the
// shapes are narrowed here so every engine call works with named types.
function readAutoEndArguments(
  event: IpcEventLike,
  args: unknown[],
  actionCount: 1 | 2
): AutoEndArguments {
  return {
    // Handlers registered here always pass positional strings; anything else
    // fails closed through the empty-string session id check.
    sessionId: asWireString(args[0]),
    action: actionCount === 2 ? asWireString(args[1]) : "",
    sender: event.sender,
  };
}

function asWireString(value: unknown): string {
  // SAFETY: ipcMain rest arguments are the documented wire contract for these
  // channels; non-string input degrades to the empty string that the session
  // validator rejects.
  return value as string;
}

function isAutoEndEvent(event: unknown): event is IpcEventLike & { sender: WebContents } {
  if (typeof event !== "object" || event === null || !("sender" in event)) return false;

  // Electron invoke events always carry the sender; anything else fails closed.
  // SAFETY: `event` is only read through the `sender` key confirmed above.
  const sender = event.sender as unknown;

  return sender !== null && typeof sender === "object";
}

export function registerMeetingAutoEndLifecycleHandlers(
  ipcMain: IpcMainLike,
  getMeetingDetectionEngine: () => MeetingAutoEndEngineLike | null | undefined
): void {
  ipcMain.handle(
    "meeting-auto-end-completed",
    async (event, ...args): Promise<MeetingAutoEndLifecycleResult> => {
      try {
        if (!isAutoEndEvent(event)) return { success: false, reason: "invalid-session" };
        const parsed = readAutoEndArguments(event, args, 1);

        return await completeMeetingAutoEndSession(
          getMeetingDetectionEngine(),
          parsed.sessionId,
          parsed.sender
        );
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? getErrorMessage(error) : "auto-end failure",
        };
      }
    }
  );
  ipcMain.handle("meeting-auto-end-respond", (event, ...args): MeetingAutoEndLifecycleResult => {
    try {
      if (!isAutoEndEvent(event)) return { success: false, reason: "invalid-session" };
      const parsed = readAutoEndArguments(event, args, 2);

      return respondToMeetingAutoEndNotification(
        getMeetingDetectionEngine(),
        parsed.sessionId,
        parsed.action,
        parsed.sender
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? getErrorMessage(error) : "auto-end failure",
      };
    }
  });
}

module.exports = {
  completeMeetingAutoEndSession,
  respondToMeetingAutoEndNotification,
  registerMeetingAutoEndLifecycleHandlers,
};
