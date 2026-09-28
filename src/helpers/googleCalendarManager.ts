import { net } from "electron";
import debugLogger from "./debugLogger.js";
import { GoogleCalendarOAuth } from "./googleCalendarOAuth.js";
import { fetchGooglePeople, lacksPeopleAccess, type GooglePersonProfile } from "./googlePeople.js";
import { CalendarSyncInterval } from "./calendarSyncInterval.js";
import { MAX_BUFFER_MINUTES } from "./calendarAvailability.js";
import { extractMeetingUrl } from "./meetingJoinUrl.js";
import { calendarDescriptionText } from "./calendarDescription.js";
import { sendGcalConnectionChanged, sendGcalEventsSynced } from "./calendarEvents.js";
import type {
  CalendarAccountRow,
  CalendarEventInput,
  GoogleCalendarInput,
  GoogleCalendarRow,
} from "./database.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const BUFFER_COVERAGE_MS = MAX_BUFFER_MINUTES * 60 * 1000;
const ALL_DAY_TIMEZONE_PADDING_MS = 48 * 60 * 60 * 1000;

// Sync tokens pin the full sync's timeMin/timeMax window, so discard them
// after a day to keep the lookahead covering the 31-day availability horizon.
const SYNC_LOOKAHEAD_MS = 33 * 24 * 60 * 60 * 1000;
const SYNC_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const GOOGLE_RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  "accepted",
  "declined",
  "tentative",
  "needsAction",
]);

// Raw Google API shapes — parsed from unknown provider payloads, then mapped
// to internal DB rows. Only the fields the manager actually reads are typed.
interface GoogleCalendarListItem {
  id: string;
  summary: string;
  description?: string;
  backgroundColor?: string;
  primary?: boolean;
}

interface GoogleAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
}

interface GoogleEventItem {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  transparency?: string;
  attendees?: GoogleAttendee[];
  hangoutLink?: string;
  htmlLink?: string;
  location?: string;
  description?: string;
  conferenceData?: unknown;
  organizer?: { email?: string };
}

interface GoogleEventsPage {
  items?: GoogleEventItem[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

class ApiGetError extends Error {
  statusCode?: number;
}

export interface GoogleManagerDb {
  getGoogleAccounts(): CalendarAccountRow[];
  getAllGoogleTokens(): Array<{ access_token: string }>;
  removeGoogleAccount(email: string): unknown;
  clearGoogleCalendarData(): unknown;
  saveGoogleCalendars(calendars: GoogleCalendarInput[], accountEmail: string | null): unknown;
  getGoogleCalendars(accountEmail?: string | null): GoogleCalendarRow[];
  getSelectedCalendars(accountEmail?: string | null): GoogleCalendarRow[];
  applyPrimaryOnlyToSelection(primaryOnly: boolean): unknown;
  updateCalendarSelection(id: string, selected: boolean): unknown;
  removeEventsFromDeselectedCalendars(provider: string): unknown;
  upsertCalendarEvents(events: CalendarEventInput[]): unknown;
  removeCalendarEvents(ids: string[]): unknown;
  removeStaleCalendarEvents(provider: string, calendarId: string, freshIds: string[]): unknown;
  updateCalendarSyncToken(id: string, token: string, expiresAt: number): unknown;
  upsertContacts(contacts: Array<{ email?: string; displayName?: string | null }>): unknown;
  upsertGooglePeople(profiles: GooglePersonProfile[]): unknown;
  getGoogleTokensByEmail(email: string): { scope: string } | null;
  getUpcomingEvents(windowMinutes?: number): unknown[];
}

// Contacts change slowly; names and photos refresh a few times a day.
const PEOPLE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ReminderSchedulerLike {
  scheduleNextMeeting(): void;
  reset(provider: string): void;
}

export class GoogleCalendarManager {
  private readonly databaseManager: GoogleManagerDb;
  private readonly reminderScheduler: ReminderSchedulerLike;
  private readonly oauth: GoogleCalendarOAuth;
  private accounts = new Map<string, { email: string }>();
  private primaryOnly = true;
  private readonly syncRunner: CalendarSyncInterval;
  private readonly peopleSyncedAt = new Map<string, number>();

  constructor(
    databaseManager: GoogleManagerDb & ConstructorParameters<typeof GoogleCalendarOAuth>[0],
    _windowManager: unknown,
    reminderScheduler: ReminderSchedulerLike
  ) {
    this.databaseManager = databaseManager;
    this.reminderScheduler = reminderScheduler;
    this.oauth = new GoogleCalendarOAuth(databaseManager);
    this.syncRunner = new CalendarSyncInterval(
      () => this.syncEvents().then(() => this.reminderScheduler.scheduleNextMeeting()),
      { intervalMs: 2 * 60 * 1000, maxIntervalMs: 30 * 60 * 1000, logScope: "gcal" }
    );
  }

  start(): void {
    this._loadAccounts();
    if (this.accounts.size === 0) return;

    this.fetchCalendars()
      .then(() => this.syncEvents())
      .then(() => this.reminderScheduler.scheduleNextMeeting())
      .catch((err) =>
        debugLogger.error("Initial calendar sync failed", { error: (err as Error).message }, "gcal")
      );

    this.syncRunner.start();
  }

  stop(): void {
    this.syncRunner.stop();
  }

  isConnected(): boolean {
    return this.accounts.size > 0;
  }

  isConfigured(): boolean {
    return this.oauth.isConfigured();
  }

  addAccount(email: string): void {
    this.accounts.set(email, { email });
  }

  removeAccount(email: string): void {
    this.accounts.delete(email);
    this.databaseManager.removeGoogleAccount(email);
    this._broadcastAccountsChanged();

    if (this.accounts.size === 0) {
      this.stop();
      this.reminderScheduler.reset("google");
      this.reminderScheduler.scheduleNextMeeting();
    }
  }

  async startOAuth(): Promise<{ success: boolean; email?: string; error?: string }> {
    const result = await this.oauth.startOAuthFlow();
    this.addAccount(result.email);
    // A reconnect may have just granted People access.
    this.peopleSyncedAt.delete(result.email);

    await this.fetchCalendars(result.email);
    await this.syncEvents();
    this.reminderScheduler.scheduleNextMeeting();
    this.syncRunner.start();
    this._broadcastAccountsChanged();

    return result;
  }

  async revokeAllTokens(): Promise<void> {
    try {
      const allTokens = this.databaseManager.getAllGoogleTokens();
      await Promise.allSettled(allTokens.map((t) => this.oauth.revokeToken(t.access_token)));
    } catch (err) {
      debugLogger.error("Error revoking Google tokens", { error: (err as Error).message }, "gcal");
    }
    this.disconnect();
  }

  disconnect(email?: string | null): void {
    if (email) {
      this.removeAccount(email);
    } else {
      this.stop();
      this.accounts.clear();
      this.databaseManager.clearGoogleCalendarData();
      this.reminderScheduler.reset("google");
      this.reminderScheduler.scheduleNextMeeting();
      this._broadcastAccountsChanged();
    }
  }

  getConnectionStatus(): {
    connected: boolean;
    configured: boolean;
    accounts: CalendarAccountRow[];
    peopleAccessMissing: string[];
    email: string | null;
  } {
    const accounts = this.databaseManager.getGoogleAccounts();
    return {
      connected: accounts.length > 0,
      configured: this.isConfigured(),
      accounts,
      peopleAccessMissing: accounts
        .map((account) => account.email)
        .filter((email) => lacksPeopleAccess(this.databaseManager.getGoogleTokensByEmail(email)?.scope)),
      // Backwards compat
      email: accounts[0]?.email || null,
    };
  }

  getAccounts(): CalendarAccountRow[] {
    return this.databaseManager.getGoogleAccounts();
  }

  async fetchCalendars(accountEmail: string | null = null): Promise<GoogleCalendarInput[]> {
    const emails = accountEmail ? [accountEmail] : this._getAccountEmails();
    const allCalendars: GoogleCalendarInput[] = [];

    for (const email of emails) {
      try {
        const data = (await this._apiGet("/users/me/calendarList", email)) as {
          items?: GoogleCalendarListItem[];
        };
        const calendars: GoogleCalendarInput[] = (data.items || []).map((item) => ({
          id: item.id,
          summary: item.summary,
          description: item.description || null,
          background_color: item.backgroundColor || null,
          is_primary: item.primary === true,
        }));
        this.databaseManager.saveGoogleCalendars(calendars, email);
        allCalendars.push(...calendars);
      } catch (err) {
        debugLogger.error("Error fetching calendars", { email, error: (err as Error).message }, "gcal");
      }
    }

    this.databaseManager.applyPrimaryOnlyToSelection(this.primaryOnly);
    this.databaseManager.removeEventsFromDeselectedCalendars("google");
    return allCalendars;
  }

  async syncEvents(): Promise<void> {
    const selectedCalendars = this.databaseManager.getSelectedCalendars();
    if (selectedCalendars.length === 0) return;

    for (const calendar of selectedCalendars) {
      try {
        await this._syncCalendar(calendar);
      } catch (err) {
        debugLogger.error(
          "Error syncing calendar",
          { calendarId: calendar.id, error: (err as Error).message },
          "gcal"
        );
      }
    }

    sendGcalEventsSynced();
    this.reminderScheduler.scheduleNextMeeting();
    void this.syncPeople();
  }

  /**
   * Refreshes attendee names and photos from each account's Google People
   * data, at most every PEOPLE_SYNC_INTERVAL_MS per account. Renderers re-read
   * profiles on the events-synced signal sent afterwards.
   */
  async syncPeople({ force = false }: { force?: boolean } = {}): Promise<void> {
    let updated = false;
    for (const email of this._getAccountEmails()) {
      const scope = this.databaseManager.getGoogleTokensByEmail(email)?.scope ?? "";
      if (lacksPeopleAccess(scope)) continue;
      const last = this.peopleSyncedAt.get(email) ?? 0;
      if (!force && Date.now() - last < PEOPLE_SYNC_INTERVAL_MS) continue;
      this.peopleSyncedAt.set(email, Date.now());
      try {
        const profiles = await fetchGooglePeople(
          (url) => this._apiGet(url, email),
          scope,
          (source, error) =>
            debugLogger.warn("Google People source failed", { source, error: error.message }, "gcal")
        );
        if (profiles.length > 0) {
          this.databaseManager.upsertGooglePeople(profiles);
          updated = true;
        }
        debugLogger.info("Google People synced", { profiles: profiles.length }, "gcal");
      } catch (err) {
        debugLogger.error("Google People sync failed", { error: (err as Error).message }, "gcal");
      }
    }
    if (updated) sendGcalEventsSynced();
  }

  private async _syncCalendar(calendar: GoogleCalendarRow): Promise<void> {
    const accountEmail = calendar.account_email;

    const buildFullParams = () =>
      new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        timeMin: new Date(
          Date.now() - BUFFER_COVERAGE_MS - ALL_DAY_TIMEZONE_PADDING_MS
        ).toISOString(),
        timeMax: new Date(
          Date.now() + SYNC_LOOKAHEAD_MS + ALL_DAY_TIMEZONE_PADDING_MS
        ).toISOString(),
      });

    const hasFreshToken = Boolean(
      calendar.sync_token && (calendar.sync_token_expires_at ?? 0) > Date.now()
    );
    let isFullSync = !hasFreshToken;
    let tokenExpiresAt = hasFreshToken
      ? (calendar.sync_token_expires_at as number)
      : Date.now() + SYNC_TOKEN_TTL_MS;
    let baseParams = isFullSync
      ? buildFullParams()
      : new URLSearchParams({
          singleEvents: "true",
          syncToken: calendar.sync_token as string,
        });
    let pageToken: string | null = null;
    let nextSyncToken: string | null = null;
    const allItems: GoogleEventItem[] = [];

    for (;;) {
      const params = new URLSearchParams(baseParams);
      if (pageToken) params.set("pageToken", pageToken);

      let data: GoogleEventsPage;
      try {
        data = (await this._apiGet(
          `/calendars/${encodeURIComponent(calendar.id)}/events?${params.toString()}`,
          accountEmail
        )) as GoogleEventsPage;
      } catch (err) {
        // 410 Gone means syncToken is invalid; fall back to full sync
        if ((err as ApiGetError).statusCode === 410 && !pageToken && !isFullSync) {
          isFullSync = true;
          tokenExpiresAt = Date.now() + SYNC_TOKEN_TTL_MS;
          baseParams = buildFullParams();
          continue;
        }
        throw err;
      }

      if (data.items) {
        allItems.push(...data.items);
      }
      pageToken = data.nextPageToken || null;
      if (data.nextSyncToken) {
        nextSyncToken = data.nextSyncToken;
      }

      if (!pageToken) break;
    }

    const toUpsert: CalendarEventInput[] = [];
    const toRemove: string[] = [];
    const contactsToUpsert: Array<{ email: string; displayName: string | null }> = [];

    for (const item of allItems) {
      if (item.status === "cancelled") {
        toRemove.push(item.id);
        continue;
      }

      const isAllDay = !item.start?.dateTime;
      const selfAttendee = item.attendees?.find((attendee) => attendee.self === true);
      toUpsert.push({
        id: item.id,
        calendar_id: calendar.id,
        provider: "google",
        summary: item.summary || null,
        start_time: item.start?.dateTime || (item.start?.date as string),
        end_time: item.end?.dateTime || (item.end?.date as string),
        is_all_day: isAllDay,
        status: item.status || "confirmed",
        availability_status: item.transparency === "transparent" ? "free" : "busy",
        self_response_status:
          selfAttendee?.responseStatus && GOOGLE_RESPONSE_STATUSES.has(selfAttendee.responseStatus)
            ? selfAttendee.responseStatus
            : "unknown",
        hangout_link:
          item.hangoutLink || extractMeetingUrl([item.location, item.description]) || null,
        conference_data: item.conferenceData ? JSON.stringify(item.conferenceData) : null,
        event_url: item.htmlLink || null,
        organizer_email: item.organizer?.email || null,
        attendees_count: item.attendees?.length || 0,
        attendees: item.attendees
          ? JSON.stringify(
              item.attendees.map((a) => ({
                email: a.email,
                displayName: a.displayName || null,
                responseStatus: a.responseStatus || null,
                self: a.self || false,
              }))
            )
          : null,
        description: calendarDescriptionText(item.description),
      });

      if (item.attendees) {
        for (const a of item.attendees) {
          if (a.email)
            contactsToUpsert.push({ email: a.email, displayName: a.displayName || null });
        }
      }
    }

    // A full sync has no incremental baseline, so deletions that happened
    // while the sync token was invalid never arrive as cancelled items —
    // prune what the fresh snapshot no longer contains.
    if (isFullSync) {
      this.databaseManager.removeStaleCalendarEvents(
        "google",
        calendar.id,
        toUpsert.map((event) => event.id)
      );
    }
    if (toUpsert.length > 0) this.databaseManager.upsertCalendarEvents(toUpsert);
    if (toRemove.length > 0) this.databaseManager.removeCalendarEvents(toRemove);
    if (nextSyncToken) {
      this.databaseManager.updateCalendarSyncToken(calendar.id, nextSyncToken, tokenExpiresAt);
    }
    if (contactsToUpsert.length > 0) this.databaseManager.upsertContacts(contactsToUpsert);
  }

  onWakeFromSleep(): void {
    this.syncEvents()
      .then(() => this.syncRunner.notifySuccess())
      .catch((err) =>
        debugLogger.error("Post-wake sync failed", { error: (err as Error).message }, "gcal")
      );
  }

  syncOnFocus(): void {
    if (!this.isConnected()) return;
    this.syncRunner.syncOnFocus();
  }

  getCalendars(): GoogleCalendarRow[] {
    return this.databaseManager.getGoogleCalendars();
  }

  async setCalendarSelection(calendarId: string, isSelected: boolean): Promise<void> {
    this.databaseManager.updateCalendarSelection(calendarId, isSelected);
    await this.syncEvents();
    this.syncRunner.notifySuccess();
    this.reminderScheduler.scheduleNextMeeting();
  }

  async setPrimaryOnly(value: boolean): Promise<void> {
    if (this.primaryOnly === value) return;
    this.primaryOnly = value;
    if (!this.isConnected()) return;

    await this.fetchCalendars();
    this.reminderScheduler.reset("google");
    await this.syncEvents();
    this.reminderScheduler.scheduleNextMeeting();
    sendGcalEventsSynced();
  }

  async getUpcomingEvents(windowMinutes?: number): Promise<unknown[]> {
    return this.databaseManager.getUpcomingEvents(windowMinutes);
  }

  private _loadAccounts(): void {
    const accounts = this.databaseManager.getGoogleAccounts();
    this.accounts.clear();
    for (const account of accounts) {
      this.accounts.set(account.email, { email: account.email });
    }
  }

  private _getAccountEmails(): string[] {
    return Array.from(this.accounts.keys());
  }

  private _broadcastAccountsChanged(): void {
    const accounts = this.getAccounts();
    sendGcalConnectionChanged({ accounts });
  }

  private async _apiGet(path: string, accountEmail: string | null = null): Promise<unknown> {
    const accessToken = await this.oauth.getValidAccessToken(accountEmail);
    const urlString = path.startsWith("http") ? path : `${CALENDAR_API_BASE}${path}`;

    const response = await net.fetch(urlString, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
      useSessionCookies: false,
    } as RequestInit);
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Error statuses can arrive with empty or non-JSON bodies; surface the
      // status below instead of masking it as a parse failure.
    }
    if (response.status >= 400) {
      const err = new ApiGetError(
        (parsed as { error?: { message?: string } } | null)?.error?.message ||
          `API error ${response.status}`
      );
      err.statusCode = response.status;
      throw err;
    }
    if (parsed === null) {
      throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
    }
    return parsed;
  }
}

module.exports = GoogleCalendarManager;
module.exports.GoogleCalendarManager = GoogleCalendarManager;
