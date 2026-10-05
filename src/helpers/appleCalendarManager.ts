import { spawn, type ChildProcess } from "child_process";
import { app } from "electron";
import debugLogger from "./debugLogger.js";
import { resolveBundledBinary } from "./binaryResolver.js";
import { extractMeetingUrl } from "./meetingJoinUrl.js";
import { sendAcalConnectionChanged, sendAcalEventsSynced } from "./calendarEvents.js";
import { FOCUS_SYNC_THROTTLE_MS } from "./calendarSyncInterval.js";
import type { AppleCalendarInput, AppleCalendarRow, CalendarEventInput } from "./database.js";

const BINARY_NAME = "macos-calendar-listener";
const HELPER_RESTART_BASE_MS = 1000;
const HELPER_RESTART_MAX_MS = 30 * 1000;
const AVAILABILITY_STATUSES: ReadonlySet<string> = new Set([
  "free",
  "tentative",
  "busy",
  "unavailable",
  "unknown",
]);
const RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  "accepted",
  "declined",
  "tentative",
  "needsAction",
]);

// The EventKit helper's newline-delimited JSON messages, validated before any
// DB mutation.
interface HelperPermissionMessage {
  type: "permission";
  status: string;
}

interface HelperSnapshotMessage {
  type: "snapshot";
  calendars: AppleCalendarInput[];
  events: HelperSnapshotEvent[];
}

interface HelperSnapshotEvent {
  id: string;
  calendar_id: string;
  title?: string;
  start: string;
  end: string;
  is_all_day?: boolean;
  status?: string;
  availability?: string;
  url?: string;
  location?: string;
  notes_urls?: string[];
  organizer_email?: string;
  attendees?: Array<{
    email?: string;
    name?: string;
    status?: string;
    self?: boolean;
  }>;
}

function isPermissionMessage(message: unknown): message is HelperPermissionMessage {
  const record = message as Record<string, unknown>;
  return record?.type === "permission" && typeof record.status === "string";
}

function isSnapshotMessage(message: unknown): message is HelperSnapshotMessage {
  const record = message as Record<string, unknown>;
  return (
    record?.type === "snapshot" &&
    Array.isArray((record as { calendars?: unknown }).calendars) &&
    Array.isArray((record as { events?: unknown }).events)
  );
}

function isHelperSnapshotEvent(value: unknown): value is HelperSnapshotEvent {
  const record = value as Record<string, unknown>;
  return (
    typeof record?.id === "string" &&
    typeof record.calendar_id === "string" &&
    typeof record.start === "string" &&
    typeof record.end === "string"
  );
}

export interface AppleConnectSuccess {
  success: true;
}

export type AppleConnectFailureReason =
  | "unsupported"
  | "helper-missing"
  | "denied"
  | "snapshot-failed";

export interface AppleConnectFailure {
  success: false;
  reason: AppleConnectFailureReason;
}

export type AppleConnectResult = AppleConnectSuccess | AppleConnectFailure;

interface PendingConnect {
  resolve(result: AppleConnectResult): void;
  awaitingSnapshot: boolean;
}

export interface AppleManagerDb {
  getAppleCalendars(): AppleCalendarRow[];
  saveAppleCalendars(calendars: AppleCalendarInput[]): unknown;
  replaceAppleCalendarEvents(events: CalendarEventInput[]): unknown;
  clearAppleCalendarData(): unknown;
  upsertContacts(contacts: Array<{ email?: string; displayName?: string | null }>): unknown;
}

// Reads the local EventKit store (all accounts Calendar.app aggregates) via a
// bundled Swift helper that pushes calendars+events snapshots as line-delimited
// JSON. "Connected" means apple_calendars has rows — no tokens or settings.
export class AppleCalendarManager {
  private readonly databaseManager: AppleManagerDb;
  private readonly reminderScheduler: {
    reset(provider?: string | null): void;
    scheduleNextMeeting(): void;
    reconcileProvider(provider: string): void;
  };
  private _helperProcess: ChildProcess | null = null;
  private _pendingConnect: PendingConnect | null = null;
  private _lastFocusSync = 0;
  private _restartTimer: NodeJS.Timeout | null = null;
  private _restartAttempts = 0;

  constructor(
    databaseManager: AppleManagerDb,
    reminderScheduler: {
      reset(provider?: string | null): void;
      scheduleNextMeeting(): void;
      reconcileProvider(provider: string): void;
    }
  ) {
    this.databaseManager = databaseManager;
    this.reminderScheduler = reminderScheduler;
  }

  isConnected(): boolean {
    return this.databaseManager.getAppleCalendars().length > 0;
  }

  getConnectionStatus(): { connected: boolean; sourceNames: string[] } {
    const calendars = this.databaseManager.getAppleCalendars();
    return {
      connected: calendars.length > 0,
      sourceNames: [
        ...new Set(
          calendars
            .map((cal) => cal.source_name)
            .filter((name): name is string => typeof name === "string")
        ),
      ],
    };
  }

  start(): void {
    if (process.platform !== "darwin" || !this.isConnected()) return;
    this._spawnHelper(false);
  }

  // User-initiated: spawns the helper with --request so the TCC prompt shows.
  // Resolves after the first snapshot lands (success) or access is denied.
  connect(): Promise<AppleConnectResult> {
    if (process.platform !== "darwin") {
      return Promise.resolve({ success: false, reason: "unsupported" });
    }
    this._restartAttempts = 0;
    return new Promise<AppleConnectResult>((resolve) => {
      this._pendingConnect = { resolve, awaitingSnapshot: false };
      if (!this._spawnHelper(true)) {
        this._pendingConnect = null;
        resolve({ success: false, reason: "helper-missing" });
      }
    });
  }

  disconnect(): { success: boolean } {
    this.stop();
    this._clearStoredCalendarData();
    return { success: true };
  }

  stop(): void {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._restartAttempts = 0;
    this._stopHelperProcess();
  }

  private _stopHelperProcess(): void {
    if (this._helperProcess) {
      const child = this._helperProcess;
      this._helperProcess = null;
      try {
        child.kill();
      } catch {
        // already exited
      }
    }
  }

  syncOnFocus(): void {
    if (!this._helperProcess) return;
    const now = Date.now();
    if (now - this._lastFocusSync < FOCUS_SYNC_THROTTLE_MS) return;
    this._lastFocusSync = now;
    this._requestSync();
  }

  onWakeFromSleep(): void {
    this._requestSync();
  }

  private _requestSync(): void {
    try {
      this._helperProcess?.stdin?.write("sync\n");
    } catch (err) {
      debugLogger.debug(
        "Calendar listener sync request failed",
        { error: (err as Error).message },
        "acal"
      );
    }
  }

  private _spawnHelper(requestAccess: boolean): boolean {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._stopHelperProcess();

    const binaryPath = resolveBundledBinary(BINARY_NAME, "acal");
    if (!binaryPath) {
      debugLogger.warn("macos-calendar-listener binary not found", {}, "acal");
      return false;
    }

    let command = binaryPath;
    let args: string[] = requestAccess ? ["--request"] : [];
    if (!app.isPackaged) {
      // A terminal-launched dev app makes the terminal the helper's TCC
      // "responsible process", and its missing calendar usage strings abort
      // the permission prompt. The disclaim shim makes the helper responsible
      // for itself so its embedded Info.plist usage strings apply. Packaged
      // builds are self-responsible and keep the helper as the prompt source.
      const shimPath = resolveBundledBinary("macos-disclaim-exec", "acal");
      if (shimPath) {
        args = [binaryPath, ...args];
        command = shimPath;
      } else {
        debugLogger.warn(
          "macos-disclaim-exec not found; calendar permission prompt may not appear in dev",
          {},
          "acal"
        );
      }
    }

    try {
      // stdin stays open for "sync" requests; its EOF also ends the helper
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this._helperProcess = child;

      let buffer = "";
      child.stdout?.on("data", (data: Buffer) => {
        if (this._helperProcess !== child) return;
        buffer += data.toString();
        let newlineIdx: number;
        while (this._helperProcess === child && (newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          try {
            this._handleMessage(JSON.parse(line));
          } catch (err) {
            debugLogger.warn(
              "Unparseable calendar listener output",
              { line, error: (err as Error).message },
              "acal"
            );
          }
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        debugLogger.debug(
          "macos-calendar-listener stderr",
          { output: data.toString().trim() },
          "acal"
        );
      });

      child.on("error", (err) => {
        debugLogger.warn("macos-calendar-listener error", { error: err.message }, "acal");
        this._onHelperGone(child);
      });

      child.on("exit", (code) => {
        debugLogger.info("macos-calendar-listener exited", { code }, "acal");
        this._onHelperGone(child);
      });

      return true;
    } catch (err) {
      debugLogger.warn("Failed to spawn macos-calendar-listener", { error: (err as Error).message }, "acal");
      return false;
    }
  }

  // A stale child callback must not own the replacement helper.
  private _onHelperGone(child: ChildProcess): void {
    if (this._helperProcess !== child) return;
    this._helperProcess = null;

    if (this._pendingConnect) {
      const pending = this._pendingConnect;
      this._pendingConnect = null;
      pending.resolve({ success: false, reason: "denied" });
    }

    this._scheduleHelperRestart();
  }

  private _scheduleHelperRestart(): void {
    if (process.platform !== "darwin" || this._restartTimer || this._helperProcess) return;

    try {
      if (!this.isConnected()) return;
    } catch (err) {
      debugLogger.warn(
        "Could not determine whether calendar listener should restart",
        { error: (err as Error).message },
        "acal"
      );
      return;
    }

    const delay = Math.min(
      HELPER_RESTART_BASE_MS * Math.pow(2, this._restartAttempts),
      HELPER_RESTART_MAX_MS
    );
    this._restartAttempts += 1;
    debugLogger.info(
      "Scheduling calendar listener restart",
      { delayMs: delay, attempt: this._restartAttempts },
      "acal"
    );

    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._spawnHelper(false)) this._scheduleHelperRestart();
    }, delay);
  }

  private _handleMessage(message: unknown): void {
    if (isPermissionMessage(message)) {
      this._handlePermission(message.status);
    } else if (isSnapshotMessage(message)) {
      this._applySnapshot(message);
    }
    // Unknown message types are ignored like before: the helper's protocol
    // may grow without every consumer needing each message.
  }

  private _handlePermission(status: string): void {
    debugLogger.info("Calendar permission status", { status }, "acal");
    const pending = this._pendingConnect;

    if (pending) {
      if (status === "granted") {
        pending.awaitingSnapshot = true;
      } else if (status !== "notDetermined") {
        // notDetermined means the TCC prompt is up; wait for the re-emit
        this._pendingConnect = null;
        if (this.isConnected()) this._clearStoredCalendarData();
        pending.resolve({ success: false, reason: "denied" });
      }
      return;
    }

    if (status !== "granted" && this.isConnected()) {
      // Access revoked in System Settings; a full re-connect is required
      debugLogger.warn("Calendar access no longer granted", { status }, "acal");
      this._clearStoredCalendarData();
    }
  }

  private _applySnapshot(message: HelperSnapshotMessage): void {
    // External messages are validated before any DB mutation: only fully
    // shaped calendars and events reach the database.
    const calendars = message.calendars.filter(
      (cal): cal is AppleCalendarInput & { id: string; title: string } =>
        typeof cal?.id === "string" && typeof cal?.title === "string"
    );
    const events = message.events.filter(isHelperSnapshotEvent);
    try {
      this._restartAttempts = 0;
      this.databaseManager.saveAppleCalendars(calendars);
      this.databaseManager.replaceAppleCalendarEvents(events.map((event) => this._mapEvent(event)));

      const contacts: Array<{ email: string; displayName: string | null }> = [];
      for (const event of events) {
        for (const attendee of event.attendees || []) {
          if (attendee.email) contacts.push({ email: attendee.email, displayName: attendee.name ?? null });
        }
      }
      if (contacts.length > 0) this.databaseManager.upsertContacts(contacts);

      sendAcalEventsSynced();
      this.reminderScheduler.reconcileProvider("apple");
      this.reminderScheduler.scheduleNextMeeting();

      if (this._pendingConnect?.awaitingSnapshot) {
        const pending = this._pendingConnect;
        this._pendingConnect = null;
        pending.resolve({ success: true });
        this._broadcastConnectionChanged();
      }
    } catch (err) {
      debugLogger.error("Error applying calendar snapshot", { error: (err as Error).message }, "acal");
      if (this._pendingConnect) {
        const pending = this._pendingConnect;
        this._pendingConnect = null;
        pending.resolve({ success: false, reason: "snapshot-failed" });
      }
    }
  }

  private _mapEvent(event: HelperSnapshotEvent): CalendarEventInput {
    const attendees = event.attendees || [];
    const selfResponseStatus = attendees.find((attendee) => attendee.self === true)?.status;
    return {
      id: event.id,
      calendar_id: event.calendar_id,
      provider: "apple",
      summary: event.title || null,
      start_time: event.start,
      end_time: event.end,
      is_all_day: event.is_all_day,
      status: event.status || "confirmed",
      availability_status:
        event.availability && AVAILABILITY_STATUSES.has(event.availability)
          ? event.availability
          : "unknown",
      self_response_status:
        selfResponseStatus && RESPONSE_STATUSES.has(selfResponseStatus)
          ? selfResponseStatus
          : "unknown",
      hangout_link:
        extractMeetingUrl([event.url, event.location, ...(event.notes_urls || [])]) ??
        // Generic fallback only for the event's own URL field
        (event.url?.startsWith("https://") ? event.url : null),
      conference_data: null,
      organizer_email: event.organizer_email || null,
      attendees_count: attendees.length,
      attendees: attendees.length
        ? JSON.stringify(
            attendees.map((a) => ({
              email: a.email || null,
              displayName: a.name || null,
              responseStatus: a.status || null,
              self: a.self || false,
            }))
          )
        : null,
    };
  }

  private _broadcastConnectionChanged(): void {
    sendAcalConnectionChanged(this.getConnectionStatus());
  }

  private _clearStoredCalendarData(): void {
    this.databaseManager.clearAppleCalendarData();
    this.reminderScheduler.reset("apple");
    this.reminderScheduler.scheduleNextMeeting();
    this._broadcastConnectionChanged();
    sendAcalEventsSynced();
  }
}

module.exports = AppleCalendarManager;
module.exports.AppleCalendarManager = AppleCalendarManager;
