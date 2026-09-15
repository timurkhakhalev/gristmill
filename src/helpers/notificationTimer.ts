const DETECTION_TIMEOUT_MS = 30 * 1000;
// Calendar reminders fire 60s before the meeting (MEETING_REMINDER_LEAD_MS in
// calendarReminderScheduler.js); the prompt must survive past the meeting
// start, not vanish 30s before it.
const CALENDAR_TIMEOUT_MS = 2 * 60 * 1000;
// A resumed countdown keeps at least this much runway so the card cannot
// vanish right as the pointer leaves it — or mid-click, while the renderer's
// 200ms dismiss animation delays the response IPC.
const MIN_RESUME_MS = 5 * 1000;

export function getNotificationTimeoutMs(source?: string | null): number {
  return source === "calendar" ? CALENDAR_TIMEOUT_MS : DETECTION_TIMEOUT_MS;
}

// Auto-dismiss countdown for the meeting notification overlay, pausable while
// the user is interacting with the card.
export class NotificationDismissTimer {
  private _onTimeout: () => void;
  private _timer: NodeJS.Timeout | null = null;
  private _deadline: number | null = null;
  private _pausedRemainingMs: number | null = null;

  constructor(onTimeout: () => void) {
    this._onTimeout = onTimeout;
  }

  start(durationMs: number): void {
    this.cancel();
    this._arm(durationMs);
  }

  pause(): void {
    if (!this._timer) return;
    clearTimeout(this._timer);
    this._timer = null;
    this._pausedRemainingMs = Math.max(0, (this._deadline ?? 0) - Date.now());
    this._deadline = null;
  }

  resume(): void {
    if (this._pausedRemainingMs === null) return;
    this._arm(Math.max(this._pausedRemainingMs, MIN_RESUME_MS));
  }

  cancel(): void {
    if (this._timer) {
      clearTimeout(this._timer);
    }
    this._timer = null;
    this._deadline = null;
    this._pausedRemainingMs = null;
  }

  private _arm(durationMs: number): void {
    this._pausedRemainingMs = null;
    this._deadline = Date.now() + durationMs;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._deadline = null;
      this._onTimeout();
    }, durationMs);
  }
}
