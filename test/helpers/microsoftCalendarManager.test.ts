const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const Module = require("node:module");

import type { CalendarEventInput } from "../../src/helpers/database.ts";

const managerModulePath = require.resolve("../../src/helpers/microsoftCalendarManager.ts");

const originalLoad = Module._load;

test("getConnectionStatus reports Microsoft OAuth registration state", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const previousId = process.env.MICROSOFT_CALENDAR_CLIENT_ID;
  delete process.env.MICROSOFT_CALENDAR_CLIENT_ID;

  try {
    const manager = new MicrosoftCalendarManager(
      { getMicrosoftAccounts: () => [] },
      {
        scheduleNextMeeting: () => {},
        reset: () => {},
      }
    );

    assert.equal(manager.getConnectionStatus().configured, false);
    process.env.MICROSOFT_CALENDAR_CLIENT_ID = "client-id";
    assert.equal(manager.getConnectionStatus().configured, true);
  } finally {
    if (previousId === undefined) delete process.env.MICROSOFT_CALENDAR_CLIENT_ID;
    else process.env.MICROSOFT_CALENDAR_CLIENT_ID = previousId;
  }
});

function loadManagerModule() {
  delete require.cache[managerModulePath];
  Module._load = function loadWithElectronMock(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") {
      return { net: {}, BrowserWindow: { getAllWindows: () => [] } };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test("normalizeGraphDateTime converts Graph timestamps to SQLite-parseable UTC", () => {
  const { normalizeGraphDateTime } = loadManagerModule();

  assert.equal(
    normalizeGraphDateTime({ dateTime: "2026-07-20T17:00:00.0000000" }),
    "2026-07-20T17:00:00Z"
  );
  assert.equal(normalizeGraphDateTime({ dateTime: "2026-07-20T17:00:00" }), "2026-07-20T17:00:00Z");
});

test("normalizeGraphDateTime keeps only the date for all-day events", () => {
  const { normalizeGraphDateTime } = loadManagerModule();

  assert.equal(
    normalizeGraphDateTime({ dateTime: "2026-07-22T00:00:00.0000000" }, true),
    "2026-07-22"
  );
});

test("_mapEvent stores all-day events as date-only local calendar days", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});

  const mapped = manager._mapEvent(
    {
      id: "evt-ooo",
      subject: "Out of office",
      start: { dateTime: "2026-07-22T00:00:00.0000000" },
      end: { dateTime: "2026-07-23T00:00:00.0000000" },
      isAllDay: true,
      isCancelled: false,
      showAs: "oof",
    },
    { id: "cal-1", account_email: "me@example.com" }
  );

  assert.equal(mapped.start_time, "2026-07-22");
  assert.equal(mapped.end_time, "2026-07-23");
  assert.equal(mapped.is_all_day, true);
  assert.equal(mapped.availability_status, "unavailable");
});

test("_mapEvent maps a Graph event to the shared calendar_events shape", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});
  const calendar = { id: "cal-1", account_email: "Me@Example.com" };

  const mapped = manager._mapEvent(
    {
      id: "evt-1",
      subject: "Standup",
      start: { dateTime: "2026-07-20T17:00:00.0000000" },
      end: { dateTime: "2026-07-20T17:30:00.0000000" },
      isAllDay: false,
      isCancelled: false,
      showAs: "workingElsewhere",
      responseStatus: { response: "declined" },
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
      organizer: { emailAddress: { address: "organizer@example.com" } },
      attendees: [
        {
          emailAddress: { address: "me@example.com", name: "Me" },
          status: { response: "tentativelyAccepted" },
        },
        { emailAddress: { address: "other@example.com" }, status: { response: "notResponded" } },
      ],
    },
    calendar
  );

  assert.equal(mapped.provider, "microsoft");
  assert.equal(mapped.summary, "Standup");
  assert.equal(mapped.start_time, "2026-07-20T17:00:00Z");
  assert.equal(mapped.status, "confirmed");
  assert.equal(mapped.availability_status, "free");
  assert.equal(mapped.self_response_status, "declined");
  assert.equal(mapped.hangout_link, "https://teams.microsoft.com/l/meetup-join/abc");
  assert.equal(mapped.organizer_email, "organizer@example.com");
  assert.equal(mapped.attendees_count, 2);

  const attendees = JSON.parse(mapped.attendees);
  assert.deepEqual(attendees[0], {
    email: "me@example.com",
    displayName: "Me",
    responseStatus: "tentative",
    self: true,
  });
  assert.deepEqual(attendees[1], {
    email: "other@example.com",
    displayName: null,
    responseStatus: "needsAction",
    self: false,
  });
});

test("_mapEvent falls back to a meeting link found in location or body text", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});

  const mapped = manager._mapEvent(
    {
      id: "evt-2",
      subject: "External call",
      start: { dateTime: "2026-07-21T09:00:00.0000000" },
      end: { dateTime: "2026-07-21T10:00:00.0000000" },
      isAllDay: false,
      isCancelled: true,
      bodyPreview: "Join here: https://example.zoom.us/j/123456789.",
    },
    { id: "cal-1", account_email: "me@example.com" }
  );

  assert.equal(mapped.status, "cancelled");
  assert.equal(mapped.hangout_link, "https://example.zoom.us/j/123456789");
  assert.equal(mapped.attendees, null);
});

function createManager(
  MicrosoftCalendarManager: any,
  upserted: CalendarEventInput[],
  contacts: { email?: string; displayName?: string | null }[] = [],
  overrides = {}
) {
  return new MicrosoftCalendarManager(
    {
      getMicrosoftTokensByEmail: () => ({ id: 1 }),
      removeStaleCalendarEvents: () => {},
      upsertCalendarEvents: (events: CalendarEventInput[]) => upserted.push(...events),
      removeCalendarEvents: () => {},
      updateMicrosoftCalendarSyncToken: () => {},
      upsertContacts: (rows: { email?: string; displayName?: string | null }[]) =>
        contacts.push(...rows),
      getCalendarEventById: () => null,
      ...overrides,
    },
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
}

const STRIPPED_OCCURRENCE = {
  id: "occ-1",
  type: "occurrence",
  seriesMasterId: "master-1",
  start: { dateTime: "2026-07-20T09:25:00.0000000" },
  end: { dateTime: "2026-07-20T09:30:00.0000000" },
};

test("_syncCalendar backfills stripped recurring occurrences from their series master", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const upserted: CalendarEventInput[] = [];
  const contacts: { email?: string; displayName?: string | null }[] = [];
  const tokenWrites: { id: unknown; token: string; expiresAt: number }[] = [];

  const manager = createManager(MicrosoftCalendarManager, upserted, contacts, {
    updateMicrosoftCalendarSyncToken: (id: unknown, token: string, expiresAt: number) =>
      tokenWrites.push({ id, token, expiresAt }),
  });

  const masterFetches: string[] = [];
  manager._apiGet = async (url: string) => {
    if (url.includes("/calendarView/delta")) {
      return {
        "@odata.deltaLink": "delta-link",
        value: [
          STRIPPED_OCCURRENCE,
          {
            ...STRIPPED_OCCURRENCE,
            id: "occ-2",
            start: { dateTime: "2026-07-21T09:25:00.0000000" },
            end: { dateTime: "2026-07-21T09:30:00.0000000" },
          },
          {
            id: "evt-1",
            subject: "One-off",
            start: { dateTime: "2026-07-20T17:00:00.0000000" },
            end: { dateTime: "2026-07-20T17:30:00.0000000" },
          },
        ],
      };
    }

    masterFetches.push(url);

    return {
      id: "master-1",
      subject: "Standup",
      isAllDay: false,
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
      organizer: { emailAddress: { address: "organizer@example.com" } },
      attendees: [
        {
          emailAddress: { address: "me@example.com", name: "Me" },
          status: { response: "accepted" },
        },
      ],
    };
  };

  await manager._syncCalendar({ id: "cal-1", account_email: "me@example.com" });

  assert.equal(masterFetches.length, 1);
  assert.match(masterFetches[0], /^\/me\/calendars\/cal-1\/events\/master-1\?\$select=/);

  const occurrence = upserted.find((event) => event.id === "occ-1");
  assert.ok(occurrence);
  assert.equal(occurrence.summary, "Standup");
  assert.equal(occurrence.start_time, "2026-07-20T09:25:00Z");
  assert.equal(occurrence.hangout_link, "https://teams.microsoft.com/l/meetup-join/abc");
  assert.equal(occurrence.organizer_email, "organizer@example.com");
  assert.equal(occurrence.attendees_count, 1);
  const secondOccurrence = upserted.find((event) => event.id === "occ-2");
  const oneOff = upserted.find((event) => event.id === "evt-1");
  assert.ok(secondOccurrence);
  assert.ok(oneOff);
  assert.equal(secondOccurrence.summary, "Standup");
  assert.equal(oneOff.summary, "One-off");
  assert.ok(contacts.some((contact) => contact.email === "me@example.com"));
  assert.ok(tokenWrites[0].expiresAt > Date.now() + 6 * 24 * 60 * 60 * 1000);
});

test("_syncCalendar inserts a never-seen stripped occurrence bare when the series master fetch fails", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const upserted: CalendarEventInput[] = [];
  const manager = createManager(MicrosoftCalendarManager, upserted);

  manager._apiGet = async (url: string) => {
    if (url.includes("/calendarView/delta")) {
      return { "@odata.deltaLink": "delta-link", value: [STRIPPED_OCCURRENCE] };
    }

    throw new Error("master gone");
  };

  await manager._syncCalendar({ id: "cal-1", account_email: "me@example.com" });

  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].id, "occ-1");
  assert.equal(upserted[0].summary, null);
  assert.equal(upserted[0].start_time, "2026-07-20T09:25:00Z");
});

test("_syncCalendar shortens the delta token TTL when a master fetch fails", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const upserted: CalendarEventInput[] = [];
  const tokenWrites: { id: unknown; token: string; expiresAt: number }[] = [];

  const manager = createManager(MicrosoftCalendarManager, upserted, [], {
    updateMicrosoftCalendarSyncToken: (id: unknown, token: string, expiresAt: number) =>
      tokenWrites.push({ id, token, expiresAt }),
  });

  manager._apiGet = async (url: string) => {
    if (url.includes("/calendarView/delta")) {
      return { "@odata.deltaLink": "delta-link", value: [STRIPPED_OCCURRENCE] };
    }

    throw new Error("master gone");
  };

  await manager._syncCalendar({ id: "cal-1", account_email: "me@example.com" });

  assert.equal(tokenWrites.length, 1);
  assert.ok(
    tokenWrites[0].expiresAt <= Date.now() + 10 * 60 * 1000,
    `expected a shortened TTL, got expiry ${tokenWrites[0].expiresAt - Date.now()}ms out`
  );
});

// Regression: the manager used to resolve syncEvents() even when every
// calendar failed, so the runner treated a provider outage as success. The
// real manager must return an explicit whole-pass outcome.
test("syncEvents reports a full failure when every selected calendar errors", async () => {
  const MicrosoftCalendarManager = loadManagerModule();

  const manager = createManager(MicrosoftCalendarManager, [], [], {
    getSelectedMicrosoftCalendars: () => [
      { id: "cal-1", account_email: "me@example.com" },
      { id: "cal-2", account_email: "me@example.com" },
    ],
  });

  manager._apiGet = async () => {
    throw new Error("graph down");
  };

  const outcome = await manager.syncEvents();

  assert.equal(outcome.total, 2);
  assert.equal(outcome.succeeded, 0);
  assert.equal(outcome.failed, 2);
  assert.deepEqual(outcome.errors, ["graph down", "graph down"]);
});

test("syncEvents keeps successful updates and reports a partial outcome", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const upserted: CalendarEventInput[] = [];

  const manager = createManager(MicrosoftCalendarManager, upserted, [], {
    getSelectedMicrosoftCalendars: () => [
      { id: "cal-ok", account_email: "me@example.com" },
      { id: "cal-bad", account_email: "me@example.com" },
    ],
  });

  manager._apiGet = async (url: string) => {
    if (url.includes("cal-bad")) throw new Error("calendar b failed");

    return {
      "@odata.deltaLink": "delta",
      value: [
        {
          id: "evt-ok",
          subject: "Kept",
          start: { dateTime: "2026-07-20T17:00:00.0000000" },
          end: { dateTime: "2026-07-20T17:30:00.0000000" },
        },
      ],
    };
  };

  const outcome = await manager.syncEvents();

  assert.equal(outcome.total, 2);
  assert.equal(outcome.succeeded, 1);
  assert.equal(outcome.failed, 1);
  assert.deepEqual(outcome.errors, ["calendar b failed"]);
  assert.deepEqual(
    upserted.map((event) => event.id),
    ["evt-ok"],
    "the successful calendar's update persists"
  );
});

// A bare stub has attendees_count 0 and no join link, which the reminder
// scheduler treats as a time block — it must not overwrite a full row.
test("_syncCalendar keeps the stored row when a stripped occurrence's master fetch fails", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const upserted: CalendarEventInput[] = [];
  const staleKeepLists: unknown[] = [];

  const manager = createManager(MicrosoftCalendarManager, upserted, [], {
    getCalendarEventById: (id: unknown) => (id === "occ-1" ? { id, summary: "Standup" } : null),
    removeStaleCalendarEvents: (_provider: unknown, _calendarId: unknown, keepIds: unknown) =>
      staleKeepLists.push(keepIds),
  });

  manager._apiGet = async (url: string) => {
    if (url.includes("/calendarView/delta")) {
      return {
        "@odata.deltaLink": "delta-link",
        value: [
          STRIPPED_OCCURRENCE,
          {
            id: "evt-1",
            subject: "One-off",
            start: { dateTime: "2026-07-20T17:00:00.0000000" },
            end: { dateTime: "2026-07-20T17:30:00.0000000" },
          },
        ],
      };
    }

    throw new Error("master gone");
  };

  // No sync_token → full sync, so the stale prune runs and must spare occ-1.
  await manager._syncCalendar({ id: "cal-1", account_email: "me@example.com" });

  assert.deepEqual(
    upserted.map((event) => event.id),
    ["evt-1"]
  );
  assert.deepEqual(staleKeepLists, [["occ-1", "evt-1"]]);
});
