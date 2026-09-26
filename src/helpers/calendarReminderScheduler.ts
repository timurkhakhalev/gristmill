import debugLogger from "./debugLogger.js";
import { getMeetingJoinUrl } from "./meetingJoinUrl.js";
import type { CalendarEventRow } from "./database.js";

const MEETING_REMINDER_LEAD_MS = 60 * 1000;

function notificationKey(event: Pick<CalendarEventRow, "provider" | "id">): string {
  return `${event.provider || "google"}:${event.id}`;
}

// A solo event with no invitees and no meeting link is a time block (focus
// time, a personal reminder), not a meeting — every provider syncs those.
function isReminderEligible(event: CalendarEventRow): boolean {
  return (
    (event.attendees_count ?? 0) > 0 ||
    getMeetingJoinUrl(event as never) !== null
  );
}

export interface ReminderSchedulerDb {
  getUpcomingEvents(windowMinutes?: number): CalendarEventRow[];
  getActiveEvents(): CalendarEventRow[];
}

export interface MeetingDetectionEngine {
  handleCalendarReminder(event: CalendarEventRow): unknown;
}

// Provider-agnostic meeting reminder scheduling. Reads only the shared
// calendar_events table (deduped across providers), so a single scheduler
// serves both calendar managers without double-firing reminders.
export class CalendarReminderScheduler {
  private readonly databaseManager: ReminderSchedulerDb;
  meetingDetectionEngine: MeetingDetectionEngine | null = null;
  private nextMeetingTimer: NodeJS.Timeout | null = null;
  private meetingEndTimer: NodeJS.Timeout | null = null;
  private activeMeeting: CalendarEventRow | null = null;
  private notifiedMeetings = new Set<string>();

  constructor(databaseManager: ReminderSchedulerDb) {
    this.databaseManager = databaseManager;
  }

  scheduleNextMeeting(): void {
    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }

    const upcoming = this.databaseManager.getUpcomingEvents(1440);
    const next = upcoming.find(
      (event) => isReminderEligible(event) && !this.notifiedMeetings.has(notificationKey(event))
    );
    if (!next) return;

    const delay = new Date(next.start_time).getTime() - MEETING_REMINDER_LEAD_MS - Date.now();
    if (delay <= 0) {
      this.onMeetingStart(next);
      return;
    }

    this.nextMeetingTimer = setTimeout(() => {
      this.onMeetingStart(next);
    }, delay);
  }

  onMeetingStart(event: CalendarEventRow): void {
    if (!isReminderEligible(event)) {
      this.scheduleNextMeeting();
      return;
    }

    const events = this.databaseManager.getActiveEvents();
    const stillExists =
      events.some((e) => notificationKey(e) === notificationKey(event)) ||
      this.databaseManager
        .getUpcomingEvents(1)
        .some((e) => notificationKey(e) === notificationKey(event));

    if (!stillExists) {
      this.scheduleNextMeeting();
      return;
    }

    this.activeMeeting = event;
    this.notifiedMeetings.add(notificationKey(event));

    debugLogger.info("Calendar meeting reminder due", { eventId: event.id }, "calendar");
    this.meetingDetectionEngine?.handleCalendarReminder(event);

    this._scheduleMeetingEnd(event);

    this.scheduleNextMeeting();
  }

  onMeetingEnd(): void {
    debugLogger.info(
      "Calendar meeting ended",
      { eventId: this.activeMeeting?.id },
      "calendar"
    );
    this.activeMeeting = null;
    this._clearMeetingEndTimer();
    this.scheduleNextMeeting();
  }

  onWakeFromSleep(): void {
    const activeEvents = this.databaseManager.getActiveEvents();
    if (activeEvents.length > 0 && !this.activeMeeting) {
      this.onMeetingStart(activeEvents[0]);
    }
    this.scheduleNextMeeting();
  }

  getActiveMeetingState(): {
    activeMeeting: CalendarEventRow | null;
    activeEvents: CalendarEventRow[];
    upcomingEvents: CalendarEventRow[];
  } {
    return {
      activeMeeting: this.activeMeeting,
      activeEvents: this.databaseManager.getActiveEvents(),
      upcomingEvents: this.databaseManager.getUpcomingEvents(15),
    };
  }

  // Refresh or clear the cached active event after a provider replaces its
  // rows. Keep notifiedMeetings intact so periodic snapshots cannot re-fire a
  // reminder that was already delivered.
  reconcileProvider(provider: string): void {
    if (!this.activeMeeting || this.activeMeeting.provider !== provider) return;

    const key = notificationKey(this.activeMeeting);
    const currentEvent = [
      ...this.databaseManager.getActiveEvents(),
      ...this.databaseManager.getUpcomingEvents(1),
    ].find((event) => notificationKey(event) === key);

    if (!currentEvent) {
      this.activeMeeting = null;
      this._clearMeetingEndTimer();
      return;
    }

    this.activeMeeting = currentEvent;
    this._scheduleMeetingEnd(currentEvent);
  }

  private _scheduleMeetingEnd(event: CalendarEventRow): void {
    this._clearMeetingEndTimer();
    const endDelay = new Date(event.end_time).getTime() - Date.now();
    if (endDelay > 0) {
      this.meetingEndTimer = setTimeout(() => {
        this.onMeetingEnd();
      }, endDelay);
    }
  }

  private _clearMeetingEndTimer(): void {
    if (this.meetingEndTimer) {
      clearTimeout(this.meetingEndTimer);
      this.meetingEndTimer = null;
    }
  }

  stop(): void {
    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }
    this._clearMeetingEndTimer();
    this.activeMeeting = null;
  }

  // Re-arm after one provider's data changes without forgetting reminders
  // already delivered by the other provider.
  reset(provider: string | null = null): void {
    if (!provider) {
      this.stop();
      this.notifiedMeetings.clear();
      return;
    }

    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }

    if (this.activeMeeting?.provider === provider) {
      this.activeMeeting = null;
      this._clearMeetingEndTimer();
    }

    const prefix = `${provider}:`;
    for (const key of this.notifiedMeetings) {
      if (key.startsWith(prefix)) this.notifiedMeetings.delete(key);
    }

    this.scheduleNextMeeting();
  }
}

module.exports = CalendarReminderScheduler;
module.exports.CalendarReminderScheduler = CalendarReminderScheduler;
