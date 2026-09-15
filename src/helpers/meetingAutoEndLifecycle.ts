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

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
};

const isValidSessionId = (sessionId: unknown): sessionId is string =>
  typeof sessionId === "string" && sessionId.trim().length > 0;

export async function completeMeetingAutoEndSession(
  engine: MeetingAutoEndEngineLike | null | undefined,
  sessionId: unknown,
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
  sessionId: unknown,
  action: unknown,
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerMeetingAutoEndLifecycleHandlers(
  ipcMain: IpcMainLike,
  getMeetingDetectionEngine: () => MeetingAutoEndEngineLike | null | undefined
): void {
  ipcMain.handle("meeting-auto-end-completed", async (event, sessionId) => {
    try {
      return await completeMeetingAutoEndSession(
        getMeetingDetectionEngine(),
        sessionId,
        (event as { sender: WebContents }).sender
      );
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle("meeting-auto-end-respond", (event, sessionId, action) => {
    try {
      return respondToMeetingAutoEndNotification(
        getMeetingDetectionEngine(),
        sessionId,
        action,
        (event as { sender: WebContents }).sender
      );
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
}

module.exports = {
  completeMeetingAutoEndSession,
  respondToMeetingAutoEndNotification,
  registerMeetingAutoEndLifecycleHandlers,
};
