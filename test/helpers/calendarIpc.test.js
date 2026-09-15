// The typed calendar integration handlers after the cutover: fake managers
// over the real contract projections. Pins the configured/unconfigured
// status absence forms, OAuth/disconnect failure detail, selection and
// primary-only validation, the provider-neutral upcoming/event reads
// (invalid input rejected before the DB, malformed rows dropped) and the
// Calendar privacy opener.
const test = require("node:test");
const assert = require("node:assert/strict");

let registerCalendarIntegrationHandlers;

test.before(async () => {
  ({ registerCalendarIntegrationHandlers } = await import(
    "../../src/helpers/calendarIpcHandlers.ts"
  ));
});

function fullEventRow(overrides = {}) {
  return {
    id: "evt-1",
    calendar_id: "cal-1",
    provider: "google",
    summary: "Standup",
    start_time: "2026-09-15 10:00:00",
    end_time: "2026-09-15 10:15:00",
    is_all_day: 0,
    status: "confirmed",
    availability_status: "busy",
    self_response_status: "accepted",
    hangout_link: "https://meet.google.com/x",
    conference_data: null,
    organizer_email: "a@b.c",
    attendees_count: 3,
    attendees: JSON.stringify([{ email: "a@b.c", displayName: null, responseStatus: "accepted", self: false }]),
    synced_at: "2026-09-15 09:00:00",
    ...overrides,
  };
}

function setup({ google, microsoft, apple, upcoming, eventById, opener } = {}) {
  const calls = { upcoming: [], eventById: [], opener: 0, errors: [] };
  const managers = {
    google:
      google === undefined
        ? {
            startOAuth: async () => ({ success: true, email: "g@x.io" }),
            disconnect: () => {},
            getConnectionStatus: () => ({
              connected: true,
              configured: true,
              accounts: [{ email: "g@x.io" }],
              email: "g@x.io",
            }),
            getCalendars: () => [],
            setCalendarSelection: async () => {},
            setPrimaryOnly: async () => {},
            syncEvents: async () => {},
          }
        : google,
    microsoft:
      microsoft === undefined
        ? {
            startOAuth: async () => ({ success: true, email: "m@x.io" }),
            disconnect: () => {},
            getConnectionStatus: () => ({
              connected: false,
              configured: false,
              accounts: [],
            }),
            setPrimaryOnly: async () => {},
          }
        : microsoft,
    apple:
      apple === undefined
        ? {
            connect: async () => ({ success: true }),
            disconnect: () => ({ success: true }),
            getConnectionStatus: () => ({ connected: false, sourceNames: [] }),
          }
        : apple,
  };
  const handlers = new Map();
  registerCalendarIntegrationHandlers(
    { handle: (channel, fn) => handlers.set(channel, fn) },
    {
      googleManager: managers.google,
      microsoftManager: managers.microsoft,
      appleManager: managers.apple,
      getUpcomingEvents: async (windowMinutes) => {
        calls.upcoming.push(windowMinutes);
        return upcoming === undefined ? [fullEventRow()] : upcoming;
      },
      getCalendarEventById: (eventId) => {
        calls.eventById.push(eventId);
        return eventById === undefined ? fullEventRow() : eventById;
      },
      openCalendarPrivacySettings:
        opener === undefined
          ? async () => {
              calls.opener += 1;
              return { success: true };
            }
          : opener,
      logError: (message, data, tag) => calls.errors.push({ message, data, tag }),
    }
  );
  const call = (channel, ...args) => handlers.get(channel)(null, ...args);
  return { call, calls, handlers };
}

// --- Status absence forms ------------------------------------------------------

test("google status: live manager fields vs unconfigured fallback", async () => {
  const live = setup();
  assert.deepEqual(await live.call("gcal-get-connection-status"), {
    connected: true,
    configured: true,
    accounts: [{ email: "g@x.io" }],
    email: "g@x.io",
  });

  const failing = setup({
    google: {
      startOAuth: async () => ({ success: true }),
      disconnect: () => {},
      getConnectionStatus: () => {
        throw new Error("manager missing");
      },
      getCalendars: () => [],
      setCalendarSelection: async () => {},
      setPrimaryOnly: async () => {},
      syncEvents: async () => {},
    },
  });
  // The fallback has NO configured/accounts — absence is the signal.
  assert.deepEqual(await failing.call("gcal-get-connection-status"), {
    connected: false,
    email: null,
  });
});

test("microsoft status: fallback omits configured, keeps accounts", async () => {
  const failing = setup({
    microsoft: {
      startOAuth: async () => ({ success: true }),
      disconnect: () => {},
      getConnectionStatus: () => {
        throw new Error("no oauth client");
      },
      setPrimaryOnly: async () => {},
    },
  });
  assert.deepEqual(await failing.call("mcal-get-connection-status"), {
    connected: false,
    accounts: [],
  });
  assert.equal("configured" in (await failing.call("mcal-get-connection-status")), false);
});

test("apple status: fallback keeps sourceNames", async () => {
  const failing = setup({
    apple: {
      connect: async () => ({ success: true }),
      disconnect: () => ({ success: true }),
      getConnectionStatus: () => {
        throw new Error("not darwin");
      },
    },
  });
  assert.deepEqual(await failing.call("acal-get-connection-status"), {
    connected: false,
    sourceNames: [],
  });
});

test("a malformed successful status never passes as valid", async () => {
  const junk = setup({
    google: {
      startOAuth: async () => ({ success: true }),
      disconnect: () => {},
      getConnectionStatus: () => ({ connected: "yes" }),
      getCalendars: () => [],
      setCalendarSelection: async () => {},
      setPrimaryOnly: async () => {},
      syncEvents: async () => {},
    },
  });
  assert.deepEqual(await junk.call("gcal-get-connection-status"), {
    connected: false,
    email: null,
  });
});

// --- OAuth / disconnect / connect ----------------------------------------------

test("oauth success and failure detail per provider", async () => {
  const ok = setup();
  assert.deepEqual(await ok.call("gcal-start-oauth"), { success: true, email: "g@x.io" });
  assert.deepEqual(await ok.call("mcal-start-oauth"), { success: true, email: "m@x.io" });

  const denied = setup({
    google: {
      startOAuth: async () => {
        throw new Error("access_denied");
      },
      disconnect: () => {},
      getConnectionStatus: () => ({ connected: false, email: null }),
      getCalendars: () => [],
      setCalendarSelection: async () => {},
      setPrimaryOnly: async () => {},
      syncEvents: async () => {},
    },
  });
  assert.deepEqual(await denied.call("gcal-start-oauth"), {
    success: false,
    error: "access_denied",
  });
  assert.equal(denied.calls.errors.length, 1);
});

test("disconnect: invalid email rejected before the manager; failures carry detail", async () => {
  const { call, calls } = setup({
    google: {
      startOAuth: async () => ({ success: true }),
      disconnect: () => {
        throw new Error("db locked");
      },
      getConnectionStatus: () => ({ connected: false, email: null }),
      getCalendars: () => [],
      setCalendarSelection: async () => {},
      setPrimaryOnly: async () => {},
      syncEvents: async () => {},
    },
  });
  assert.deepEqual(await call("gcal-disconnect", 42), {
    success: false,
    error: "Invalid disconnect request",
  });
  assert.deepEqual(await call("gcal-disconnect", "g@x.io"), {
    success: false,
    error: "db locked",
  });
  // No email disconnects everything — the argument stays optional.
  assert.deepEqual(await setup().call("mcal-disconnect"), { success: true });
  void calls;
});

test("apple connect: stage reasons and disconnect passthrough", async () => {
  const denied = setup({
    apple: {
      connect: async () => ({ success: false, reason: "denied" }),
      disconnect: () => ({ success: true }),
      getConnectionStatus: () => ({ connected: false, sourceNames: [] }),
    },
  });
  assert.deepEqual(await denied.call("acal-connect"), { success: false, reason: "denied" });

  const threw = setup({
    apple: {
      connect: async () => {
        throw new Error("helper spawn failed");
      },
      disconnect: () => ({ success: true }),
      getConnectionStatus: () => ({ connected: false, sourceNames: [] }),
    },
  });
  assert.deepEqual(await threw.call("acal-connect"), {
    success: false,
    error: "helper spawn failed",
  });

  assert.deepEqual(await setup().call("acal-disconnect"), { success: true });
});

// --- Selection / primary-only / sync ---------------------------------------------

test("selection and primary-only validate args before calling the manager", async () => {
  const calls = [];
  const { call } = setup({
    google: {
      startOAuth: async () => ({ success: true }),
      disconnect: () => {},
      getConnectionStatus: () => ({ connected: false, email: null }),
      getCalendars: () => [],
      setCalendarSelection: async (id, value) => calls.push(["selection", id, value]),
      setPrimaryOnly: async (value) => calls.push(["primary", value]),
      syncEvents: async () => calls.push(["sync"]),
    },
  });
  assert.deepEqual(await call("gcal-set-calendar-selection", "", true), {
    success: false,
    error: "Invalid calendar selection request",
  });
  assert.deepEqual(await call("gcal-set-calendar-selection", "cal-1", "yes"), {
    success: false,
    error: "Invalid calendar selection request",
  });
  assert.deepEqual(await call("gcal-set-primary-only", undefined), {
    success: false,
    error: "Invalid request",
  });
  assert.deepEqual(calls, []);

  assert.deepEqual(await call("gcal-set-calendar-selection", "cal-1", false), { success: true });
  assert.deepEqual(await call("gcal-set-primary-only", true), { success: true });
  assert.deepEqual(await call("gcal-sync-events"), { success: true });
  assert.deepEqual(await call("mcal-set-primary-only", false), { success: true });
  assert.deepEqual(calls, [
    ["selection", "cal-1", false],
    ["primary", true],
    ["sync"],
  ]);
});

// --- Provider-neutral reads --------------------------------------------------------

test("upcoming events: projection keeps consumer fields and drops internals", async () => {
  const { call } = setup({ upcoming: [fullEventRow(), fullEventRow({ id: "evt-2", is_all_day: 1, start_time: "2026-09-16", end_time: "2026-09-17", attendees: null })] });
  const result = await call("gcal-get-upcoming-events", 120);
  assert.equal(result.success, true);
  assert.equal(result.events.length, 2);
  const wire = result.events[0];
  assert.equal(wire.summary, "Standup");
  assert.equal(wire.attendees_count, 3);
  assert.equal(wire.attendees.startsWith("["), true, "attendees JSON survives");
  assert.equal("synced_at" in wire, false, "internal synced_at never crosses");
  assert.equal(wire.availability_status, "busy");
  // All-day local dates keep their stored form.
  assert.equal(result.events[1].start_time, "2026-09-16");
  assert.equal(result.events[1].is_all_day, 1);
});

test("upcoming events: invalid windows and malformed rows fail closed", async () => {
  const { call, calls } = setup({ upcoming: [fullEventRow(), { id: "junk" }] });
  assert.deepEqual(await call("gcal-get-upcoming-events", 0), { success: false, events: [] });
  assert.deepEqual(await call("gcal-get-upcoming-events", -5), { success: false, events: [] });
  assert.deepEqual(await call("gcal-get-upcoming-events", "60"), { success: false, events: [] });
  assert.deepEqual(calls.upcoming, [], "invalid windows never reach the DB");

  const result = await call("gcal-get-upcoming-events", 60);
  assert.equal(result.success, true);
  assert.deepEqual(
    result.events.map((event) => event.id),
    ["evt-1"],
    "malformed row dropped, valid row kept"
  );
});

test("event lookup: invalid id rejected before the DB; missing/corrupt rows are null", async () => {
  const { call, calls } = setup({ eventById: null });
  assert.deepEqual(await call("gcal-get-event", ""), { success: false, event: null });
  assert.deepEqual(await call("gcal-get-event", null), { success: false, event: null });
  assert.deepEqual(calls.eventById, []);

  assert.deepEqual(await call("gcal-get-event", "missing"), { success: true, event: null });

  const corrupt = setup({ eventById: { id: "x", summary: "no times" } });
  assert.deepEqual(await corrupt.call("gcal-get-event", "x"), { success: true, event: null });

  const ok = setup({ eventById: fullEventRow() });
  const result = await ok.call("gcal-get-event", "evt-1");
  assert.equal(result.success, true);
  assert.equal(result.event.summary, "Standup");
  assert.equal("synced_at" in result.event, false);
});

test("calendar list projection drops sync tokens", async () => {
  const { call } = setup({
    google: {
      startOAuth: async () => ({ success: true }),
      disconnect: () => {},
      getConnectionStatus: () => ({ connected: false, email: null }),
      getCalendars: () => [
        {
          id: "cal-1",
          account_email: "g@x.io",
          summary: "Main",
          description: null,
          background_color: "#fff",
          is_selected: 1,
          is_primary: 1,
          sync_token: "secret-sync-token",
          sync_token_expires_at: 123,
          created_at: "2026-01-01 00:00:00",
        },
        { id: "junk" },
      ],
      setCalendarSelection: async () => {},
      setPrimaryOnly: async () => {},
      syncEvents: async () => {},
    },
  });
  const result = await call("gcal-get-calendars");
  assert.equal(result.success, true);
  assert.equal(result.calendars.length, 1);
  assert.equal(result.calendars[0].summary, "Main");
  assert.equal("sync_token" in result.calendars[0], false);
  assert.equal("sync_token_expires_at" in result.calendars[0], false);
  assert.equal("created_at" in result.calendars[0], false);
});

test("privacy settings go through the injected opener", async () => {
  const { call, calls } = setup();
  assert.deepEqual(await call("open-calendar-privacy-settings"), { success: true });
  assert.equal(calls.opener, 1);

  const threw = setup({
    opener: async () => {
      throw new Error("no system settings pane");
    },
  });
  assert.deepEqual(await threw.call("open-calendar-privacy-settings"), {
    success: false,
    error: "no system settings pane",
  });
});

test("read failures degrade to empty shapes, not error surfaces", async () => {
  const failing = setup({
    google: {
      startOAuth: async () => ({ success: true }),
      disconnect: () => {},
      getConnectionStatus: () => ({ connected: false, email: null }),
      getCalendars: () => {
        throw new Error("db");
      },
      setCalendarSelection: async () => {},
      setPrimaryOnly: async () => {},
      syncEvents: async () => {},
    },
  });
  assert.deepEqual(await failing.call("gcal-get-calendars"), { success: false, calendars: [] });
});
