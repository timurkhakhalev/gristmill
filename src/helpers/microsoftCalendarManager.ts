import { net } from "electron";
import debugLogger from "./debugLogger.js";
import { MicrosoftCalendarOAuth } from "./microsoftCalendarOAuth.js";
import { CalendarSyncInterval, type CalendarSyncOutcome } from "./calendarSyncInterval.js";
import { MAX_BUFFER_MINUTES } from "./calendarAvailability.js";
import { extractMeetingUrl } from "./meetingJoinUrl.js";
import { calendarDescriptionText } from "./calendarDescription.js";
import { sendMcalConnectionChanged, sendMcalEventsSynced } from "./calendarEvents.js";
import type {
  CalendarAccountRow,
  CalendarEventInput,
  MicrosoftCalendarInput,
  MicrosoftCalendarRow,
} from "./database.js";

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

const SERIES_MASTER_FIELDS =
  "subject,isAllDay,isCancelled,showAs,responseStatus,onlineMeeting,onlineMeetingUrl,location,bodyPreview,webLink,organizer,attendees";

// Graph's deltaLink permanently encodes the calendarView window it was created
// with — it never rolls forward. Sync a 38-day window and discard the token
// after 7 days so coverage never drops below the app's 31-day lookahead.
const DELTA_WINDOW_MS = 38 * 24 * 60 * 60 * 1000;
const DELTA_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A failed series-master backfill can't be retried via delta (unchanged
// occurrences are never re-delivered); a short TTL forces an early full sync.
const BACKFILL_RETRY_TTL_MS = 10 * 60 * 1000;
const BUFFER_COVERAGE_MS = MAX_BUFFER_MINUTES * 60 * 1000;
const LOOKBACK_SAFETY_MS = 24 * 60 * 60 * 1000;

const AVAILABILITY_STATUS_BY_GRAPH: Record<string, string> = {
  free: "free",
  workingElsewhere: "free",
  tentative: "tentative",
  busy: "busy",
  oof: "unavailable",
};

const RESPONSE_STATUS_BY_GRAPH: Record<string, string> = {
  accepted: "accepted",
  declined: "declined",
  tentativelyAccepted: "tentative",
};

// Raw Graph shapes — only the fields the manager reads.
interface GraphCalendarItem {
  id: string;
  name: string;
  hexColor?: string;
  isDefaultCalendar?: boolean;
}

interface GraphAttendee {
  emailAddress?: { address?: string; name?: string };
  status?: { response?: string };
}

interface GraphEventItem {
  id: string;
  seriesMasterId?: string;
  subject?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  responseStatus?: { response?: string };
  onlineMeeting?: { joinUrl?: string };
  onlineMeetingUrl?: string;
  location?: { displayName?: string };
  bodyPreview?: string;
  webLink?: string;
  organizer?: { emailAddress?: { address?: string } };
  attendees?: GraphAttendee[];
  start: { dateTime: string };
  end: { dateTime: string };
  "@removed"?: unknown;
}

interface GraphDeltaPage {
  value?: GraphEventItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

class ApiGetError extends Error {
  statusCode?: number;
}

// Graph returns "2026-07-20T17:00:00.0000000" — no offset, 7-digit fraction —
// which SQLite's datetime() cannot parse. Events are requested in UTC
// (Prefer: outlook.timezone), so trim the fraction and append "Z". All-day
// events come back as midnight in that zone, not as real instants, so keep
// only the date — date-only rows read as local days, like Google's start.date.
export function normalizeGraphDateTime(
  { dateTime }: { dateTime: string },
  isAllDay = false
): string {
  return isAllDay ? dateTime.slice(0, 10) : `${dateTime.slice(0, 19)}Z`;
}

// calendarView/delta can return recurring-series occurrences as bare
// { id, type, seriesMasterId, start, end } stubs — no subject, attendees,
// or meeting link. Those fields live on the series master.
function isStrippedOccurrence(item: GraphEventItem): boolean {
  return item.subject === undefined && Boolean(item.seriesMasterId);
}

export interface MicrosoftManagerDb {
  getMicrosoftAccounts(): CalendarAccountRow[];
  removeMicrosoftAccount(email: string): unknown;
  clearMicrosoftCalendarData(): unknown;
  saveMicrosoftCalendars(calendars: MicrosoftCalendarInput[], accountEmail: string): unknown;
  getSelectedMicrosoftCalendars(): MicrosoftCalendarRow[];
  applyMicrosoftPrimaryOnlyToSelection(primaryOnly: boolean): unknown;
  removeEventsFromDeselectedCalendars(provider: string): unknown;
  upsertCalendarEvents(events: CalendarEventInput[]): unknown;
  removeCalendarEvents(ids: string[]): unknown;
  removeStaleCalendarEvents(provider: string, calendarId: string, freshIds: string[]): unknown;
  updateMicrosoftCalendarSyncToken(id: string, token: string, expiresAt: number): unknown;
  upsertContacts(contacts: Array<{ email?: string; displayName?: string | null }>): unknown;
  getCalendarEventById(id: string): unknown;
}

export class MicrosoftCalendarManager {
  private readonly databaseManager: MicrosoftManagerDb &
    ConstructorParameters<typeof MicrosoftCalendarOAuth>[0];
  private readonly reminderScheduler: { scheduleNextMeeting(): void; reset(p: string): void; reconcileProvider(p: string): void };
  private readonly oauth: MicrosoftCalendarOAuth;
  private accounts = new Map<string, { email: string }>();
  private primaryOnly = true;
  private readonly syncRunner: CalendarSyncInterval;

  constructor(
    databaseManager: MicrosoftManagerDb & ConstructorParameters<typeof MicrosoftCalendarOAuth>[0],
    reminderScheduler: { scheduleNextMeeting(): void; reset(p: string): void; reconcileProvider(p: string): void }
  ) {
    this.databaseManager = databaseManager;
    this.reminderScheduler = reminderScheduler;
    this.oauth = new MicrosoftCalendarOAuth(databaseManager);
    this.syncRunner = new CalendarSyncInterval(() => this.syncEvents(), {
      intervalMs: 2 * 60 * 1000,
      maxIntervalMs: 30 * 60 * 1000,
      logScope: "mcal",
    });
  }

  start(): void {
    this._loadAccounts();
    if (this.accounts.size === 0) return;

    this.fetchCalendars()
      .then(() => this.syncEvents())
      .then(() => this.reminderScheduler.scheduleNextMeeting())
      .catch((err) =>
        debugLogger.error("Initial calendar sync failed", { error: (err as Error).message }, "mcal")
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
    this.databaseManager.removeMicrosoftAccount(email);
    this._broadcastAccountsChanged();
    this.reminderScheduler.reconcileProvider("microsoft");

    if (this.accounts.size === 0) {
      this.stop();
      this.reminderScheduler.reset("microsoft");
    }
    this.reminderScheduler.scheduleNextMeeting();
  }

  async startOAuth(): Promise<{ success: boolean; email?: string; error?: string }> {
    const result = await this.oauth.startOAuthFlow();
    this.addAccount(result.email);

    await this.fetchCalendars(result.email);
    await this.syncEvents();
    this.reminderScheduler.scheduleNextMeeting();
    this.syncRunner.start();
    this._broadcastAccountsChanged();

    return result;
  }

  // Microsoft has no public token-revocation endpoint for this flow; deleting
  // the local tokens severs access from our side.
  disconnect(email?: string | null): void {
    if (email) {
      this.removeAccount(email);
    } else {
      this.stop();
      this.accounts.clear();
      this.databaseManager.clearMicrosoftCalendarData();
      this.reminderScheduler.reset("microsoft");
      this.reminderScheduler.scheduleNextMeeting();
      this._broadcastAccountsChanged();
    }
  }

  getConnectionStatus(): {
    connected: boolean;
    configured: boolean;
    accounts: CalendarAccountRow[];
  } {
    const accounts = this.databaseManager.getMicrosoftAccounts();
    return { connected: accounts.length > 0, configured: this.isConfigured(), accounts };
  }

  getAccounts(): CalendarAccountRow[] {
    return this.databaseManager.getMicrosoftAccounts();
  }

  async fetchCalendars(accountEmail: string | null = null): Promise<MicrosoftCalendarInput[]> {
    const emails = accountEmail ? [accountEmail] : this._getAccountEmails();
    const allCalendars: MicrosoftCalendarInput[] = [];

    for (const email of emails) {
      try {
        const accountId = this.databaseManager.getMicrosoftTokensByEmail(email)?.id;
        this._assertAccountCurrent(email, accountId);
        const calendars: MicrosoftCalendarInput[] = [];
        let url: string | null = "/me/calendars?$select=id,name,hexColor,isDefaultCalendar";
        while (url) {
          const data = (await this._apiGet(url, email)) as Partial<GraphDeltaPage> & {
            value?: GraphCalendarItem[];
          };
          for (const item of data.value || []) {
            calendars.push({
              id: item.id,
              summary: item.name,
              background_color: item.hexColor || null,
              is_primary: item.isDefaultCalendar === true,
            });
          }
          url = data["@odata.nextLink"] || null;
        }
        this._assertAccountCurrent(email, accountId);
        this.databaseManager.saveMicrosoftCalendars(calendars, email);
        allCalendars.push(...calendars);
      } catch (err) {
        debugLogger.error("Error fetching calendars", { email, error: (err as Error).message }, "mcal");
      }
    }

    this.databaseManager.applyMicrosoftPrimaryOnlyToSelection(this.primaryOnly);
    this.databaseManager.removeEventsFromDeselectedCalendars("microsoft");
    return allCalendars;
  }

  // Best-effort per calendar: successful calendars still update, but the
  // whole-pass result is returned so orchestration can back off instead of
  // treating a fully-failed pass as success.
  async syncEvents(): Promise<CalendarSyncOutcome> {
    const selectedCalendars = this.databaseManager.getSelectedMicrosoftCalendars();
    if (selectedCalendars.length === 0) return { total: 0, succeeded: 0, failed: 0, errors: [] };

    const errors: string[] = [];
    let succeeded = 0;
    for (const calendar of selectedCalendars) {
      try {
        await this._syncCalendar(calendar);
        succeeded++;
      } catch (err) {
        errors.push((err as Error).message);
        debugLogger.error(
          "Error syncing calendar",
          { calendarId: calendar.id, error: (err as Error).message },
          "mcal"
        );
      }
    }

    sendMcalEventsSynced();
    this.reminderScheduler.scheduleNextMeeting();
    return { total: selectedCalendars.length, succeeded, failed: errors.length, errors };
  }

  private async _syncCalendar(calendar: MicrosoftCalendarRow): Promise<void> {
    const accountEmail = calendar.account_email;
    const accountId = this.databaseManager.getMicrosoftTokensByEmail(accountEmail as string)?.id;
    this._assertAccountCurrent(accountEmail, accountId);

    const items: GraphEventItem[] = [];
    const toRemove: string[] = [];
    let deltaLink: string | null = null;

    const hasFreshToken = calendar.sync_token && (calendar.sync_token_expires_at ?? 0) > Date.now();
    let isFullSync = !hasFreshToken;
    let url: string | null = hasFreshToken ? (calendar.sync_token as string) : this._deltaUrl(calendar.id);
    let tokenExpiresAt = hasFreshToken
      ? (calendar.sync_token_expires_at as number)
      : Date.now() + DELTA_TOKEN_TTL_MS;

    while (url) {
      let data: GraphDeltaPage;
      try {
        data = (await this._apiGet(url, accountEmail)) as GraphDeltaPage;
      } catch (err) {
        // 410 Gone means the delta token expired; fall back to a full sync
        if ((err as ApiGetError).statusCode === 410 && url === calendar.sync_token) {
          isFullSync = true;
          url = this._deltaUrl(calendar.id);
          tokenExpiresAt = Date.now() + DELTA_TOKEN_TTL_MS;
          continue;
        }
        throw err;
      }

      for (const item of data.value || []) {
        if (item["@removed"]) toRemove.push(item.id);
        else items.push(item);
      }

      deltaLink = data["@odata.deltaLink"] || deltaLink;
      url = data["@odata.nextLink"] || null;
    }

    const events = await this._backfillStrippedOccurrences(items, calendar);
    if (events.some(isStrippedOccurrence)) {
      tokenExpiresAt = Math.min(tokenExpiresAt, Date.now() + BACKFILL_RETRY_TTL_MS);
    }

    this._assertAccountCurrent(accountEmail, accountId);

    const toUpsert: CalendarEventInput[] = [];
    const contactsToUpsert: Array<{ email: string; displayName: string | null }> = [];
    for (const item of events) {
      // An occurrence still stripped after backfill (master fetch failed) has no
      // subject, attendees, or join link. Overwriting a row a previous sync
      // stored in full would demote that meeting to an untitled time block, so
      // keep the stored row and only insert bare stubs we've never seen.
      if (isStrippedOccurrence(item) && this.databaseManager.getCalendarEventById(item.id)) {
        continue;
      }
      toUpsert.push(this._mapEvent(item, calendar));
      for (const a of item.attendees || []) {
        if (a.emailAddress?.address) {
          contactsToUpsert.push({
            email: a.emailAddress.address,
            displayName: a.emailAddress.name || null,
          });
        }
      }
    }

    // A full sync has no delta baseline, so deletions that happened while the
    // token was invalid never arrive as @removed — prune what the fresh
    // snapshot no longer contains (kept stripped rows included).
    if (isFullSync) {
      this.databaseManager.removeStaleCalendarEvents(
        "microsoft",
        calendar.id,
        events.map((event) => event.id)
      );
    }
    if (toUpsert.length > 0) this.databaseManager.upsertCalendarEvents(toUpsert);
    if (toRemove.length > 0) this.databaseManager.removeCalendarEvents(toRemove);
    if (deltaLink) {
      this.databaseManager.updateMicrosoftCalendarSyncToken(calendar.id, deltaLink, tokenExpiresAt);
    }
    if (contactsToUpsert.length > 0) this.databaseManager.upsertContacts(contactsToUpsert);
  }

  // Merges each stripped occurrence with its series master (fetched once per
  // series, through its calendar — /me/events/{id} 404s for shared calendars);
  // the occurrence's own id/start/end win. A failed master fetch leaves its
  // occurrences bare instead of failing the calendar's sync; _syncCalendar
  // decides whether a bare stub may be written.
  private async _backfillStrippedOccurrences(
    items: GraphEventItem[],
    calendar: MicrosoftCalendarRow
  ): Promise<GraphEventItem[]> {
    const masterIds = new Set(
      items.filter(isStrippedOccurrence).map((item) => item.seriesMasterId as string)
    );
    if (masterIds.size === 0) return items;

    const calendarPath = encodeURIComponent(calendar.id);
    const masters = new Map<string, GraphEventItem>();
    for (const id of masterIds) {
      try {
        const master = (await this._apiGet(
          `/me/calendars/${calendarPath}/events/${encodeURIComponent(id)}?$select=${SERIES_MASTER_FIELDS}`,
          calendar.account_email
        )) as GraphEventItem;
        masters.set(id, master);
      } catch (err) {
        debugLogger.error(
          "Error fetching series master",
          { seriesMasterId: id, error: (err as Error).message },
          "mcal"
        );
      }
    }

    return items.map((item) => {
      const master = isStrippedOccurrence(item) ? masters.get(item.seriesMasterId as string) : null;
      return master ? { ...master, ...item } : item;
    });
  }

  private _mapEvent(item: GraphEventItem, calendar: MicrosoftCalendarRow): CalendarEventInput {
    const attendees = item.attendees || [];
    const accountEmail = (calendar.account_email || "").toLowerCase();
    return {
      id: item.id,
      calendar_id: calendar.id,
      provider: "microsoft",
      summary: item.subject || null,
      start_time: normalizeGraphDateTime(item.start, item.isAllDay),
      end_time: normalizeGraphDateTime(item.end, item.isAllDay),
      is_all_day: item.isAllDay,
      status: item.isCancelled ? "cancelled" : "confirmed",
      availability_status: AVAILABILITY_STATUS_BY_GRAPH[item.showAs ?? ""] || "unknown",
      self_response_status:
        RESPONSE_STATUS_BY_GRAPH[item.responseStatus?.response ?? ""] || "unknown",
      hangout_link:
        item.onlineMeeting?.joinUrl ||
        item.onlineMeetingUrl ||
        extractMeetingUrl([item.location?.displayName, item.bodyPreview]) ||
        null,
      conference_data: null,
      event_url: item.webLink || null,
      description: calendarDescriptionText(item.bodyPreview),
      organizer_email: item.organizer?.emailAddress?.address || null,
      attendees_count: attendees.length,
      attendees: attendees.length
        ? JSON.stringify(
            attendees.map((a) => ({
              email: a.emailAddress?.address || null,
              displayName: a.emailAddress?.name || null,
              responseStatus: RESPONSE_STATUS_BY_GRAPH[a.status?.response ?? ""] || "needsAction",
              self: (a.emailAddress?.address || "").toLowerCase() === accountEmail,
            }))
          )
        : null,
    };
  }

  onWakeFromSleep(): void {
    this.syncEvents()
      .then((outcome) => this.syncRunner.notifyOutcome(outcome))
      .catch((err) =>
        debugLogger.error("Post-wake sync failed", { error: (err as Error).message }, "mcal")
      );
  }

  syncOnFocus(): void {
    if (!this.isConnected()) return;
    this.syncRunner.syncOnFocus();
  }

  async setPrimaryOnly(value: boolean): Promise<void> {
    if (this.primaryOnly === value) return;
    this.primaryOnly = value;
    if (!this.isConnected()) return;

    await this.fetchCalendars();
    this.reminderScheduler.reset("microsoft");
    await this.syncEvents();
    this.reminderScheduler.scheduleNextMeeting();
    sendMcalEventsSynced();
  }

  private _loadAccounts(): void {
    const accounts = this.databaseManager.getMicrosoftAccounts();
    this.accounts.clear();
    for (const account of accounts) {
      this.accounts.set(account.email, { email: account.email });
    }
  }

  private _getAccountEmails(): string[] {
    return Array.from(this.accounts.keys());
  }

  // calendarView/delta expands recurrences into occurrences and returns a
  // deltaLink for incremental syncs (stored in microsoft_calendars.sync_token).
  private _deltaUrl(calendarId: string): string {
    const params = new URLSearchParams({
      startDateTime: new Date(Date.now() - LOOKBACK_SAFETY_MS - BUFFER_COVERAGE_MS).toISOString(),
      endDateTime: new Date(Date.now() + DELTA_WINDOW_MS).toISOString(),
    });
    return `/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${params.toString()}`;
  }

  private _broadcastAccountsChanged(): void {
    const accounts = this.getAccounts();
    sendMcalConnectionChanged({ accounts });
  }

  private _assertAccountCurrent(email: string | null, accountId: number | undefined): void {
    if (accountId === undefined || !email || this.databaseManager.getMicrosoftTokensByEmail(email)?.id !== accountId) {
      throw new Error("Microsoft account changed during calendar request");
    }
  }

  private async _apiGet(path: string, accountEmail: string | null): Promise<unknown> {
    const accountId = this.databaseManager.getMicrosoftTokensByEmail(accountEmail as string)?.id;
    this._assertAccountCurrent(accountEmail, accountId);
    const accessToken = await this.oauth.getValidAccessToken(accountEmail as string);
    this._assertAccountCurrent(accountEmail, accountId);
    const urlString = path.startsWith("http") ? path : `${GRAPH_API_BASE}${path}`;

    const response = await net.fetch(urlString, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="UTC"',
      },
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

module.exports = MicrosoftCalendarManager;
module.exports.MicrosoftCalendarManager = MicrosoftCalendarManager;
module.exports.normalizeGraphDateTime = normalizeGraphDateTime;
