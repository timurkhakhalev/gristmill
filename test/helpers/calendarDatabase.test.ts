const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");
const nodeCrypto: typeof import("node:crypto") = require("node:crypto");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
const originalLoad = Module._load;
const databaseModulePath = require.resolve("../../src/helpers/database.ts");
const testCryptoKey = Buffer.alloc(32, 19);
let encryptionAvailable = true;
const testSecretCrypto = {
  isAvailable: () => encryptionAvailable,
  encrypt(plaintext: string) {
    if (!encryptionAvailable) throw new Error("test encryption unavailable");
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", testCryptoKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  },
  decrypt(blob: Buffer) {
    if (!encryptionAvailable) throw new Error("test decryption unavailable");
    const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", testCryptoKey, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28));
    return {
      value: Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8"),
      needsReencrypt: false,
    };
  },
};

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      net: {},
      BrowserWindow: { getAllWindows: () => [] },
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  if ((parent as { filename?: string } | null)?.filename === databaseModulePath && request === "./secretCrypto.js") {
    return testSecretCrypto;
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager: typeof import("../../src/helpers/database.ts").DatabaseManager = require("../../src/helpers/database.ts");

function isNativeBindingUnavailable(error: unknown) {
  const message = String((error as { message?: unknown })?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

type DbUnderTest = import("../../src/helpers/database.js").DatabaseManager;
function createDb(t: import("node:test").TestContext, directory?: string): DbUnderTest | null {
  userDataDir = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
  try {
    return new DatabaseManager() as DbUnderTest;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

function databaseFiles(directory: string) {
  return fs.readdirSync(directory)
    .filter((name: string) => name.endsWith(".db") || name.endsWith(".db-wal") || name.endsWith(".db-shm"))
    .map((name: string) => fs.readFileSync(path.join(directory, name)));
}

function includesSecret(directory: string, secret: string) {
  return databaseFiles(directory).some((buffer: Buffer) => buffer.includes(Buffer.from(secret)));
}

test("Google and Microsoft calendar tokens are encrypted and survive reopening", (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openh-calendar-secure-"));
  const db = createDb(t, directory);
  if (!db) return;

  const google = {
    google_email: "google@example.com",
    access_token: "google-access-secret",
    refresh_token: "google-refresh-secret",
    expires_at: Date.now() + 60_000,
    scope: "calendar",
  };
  const microsoft = {
    microsoft_email: "microsoft@example.com",
    access_token: "microsoft-access-secret",
    refresh_token: "microsoft-refresh-secret",
    expires_at: Date.now() + 60_000,
    scope: "calendar",
  };
  db.saveGoogleTokens(google);
  db.saveMicrosoftTokens(microsoft);

  const storedGoogle = db.db.prepare("SELECT access_token, refresh_token FROM google_calendar_tokens").get() as Record<string, string>;
  const storedMicrosoft = db.db.prepare("SELECT access_token, refresh_token FROM microsoft_calendar_tokens").get() as Record<string, string>;
  assert.ok(storedGoogle.access_token.startsWith("ohenc:v1:"));
  assert.ok(storedGoogle.refresh_token.startsWith("ohenc:v1:"));
  assert.ok(storedMicrosoft.access_token.startsWith("ohenc:v1:"));
  assert.ok(storedMicrosoft.refresh_token.startsWith("ohenc:v1:"));
  for (const token of [google.access_token, google.refresh_token, microsoft.access_token, microsoft.refresh_token]) {
    assert.equal(includesSecret(directory, token), false);
  }
  encryptionAvailable = false;
  assert.deepEqual(db.getGoogleAccounts(), [], "unreadable Google tokens do not show as connected");
  assert.deepEqual(db.getMicrosoftAccounts(), [], "unreadable Microsoft tokens do not show as connected");
  encryptionAvailable = true;
  db.db.close();

  const reopened = createDb(t, directory);
  if (!reopened) return;
  assert.equal(reopened.getGoogleTokensByEmail(google.google_email)!.refresh_token, google.refresh_token);
  assert.equal(reopened.getMicrosoftTokensByEmail(microsoft.microsoft_email)!.access_token, microsoft.access_token);
  reopened.db.close();
});

test("calendar credential saves fail closed when encryption is unavailable", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;
  encryptionAvailable = false;
  try {
    assert.throws(() => db.saveGoogleTokens({
      google_email: "google@example.com",
      access_token: "rejected-google-access",
      refresh_token: "rejected-google-refresh",
      expires_at: Date.now(),
      scope: "calendar",
    }));
    assert.throws(() => db.saveMicrosoftTokens({
      microsoft_email: "microsoft@example.com",
      access_token: "rejected-ms-access",
      refresh_token: "rejected-ms-refresh",
      expires_at: Date.now(),
      scope: "calendar",
    }));
    assert.deepEqual(db.getGoogleAccounts(), []);
    assert.deepEqual(db.getMicrosoftAccounts(), []);
  } finally {
    encryptionAvailable = true;
    db.db.close();
  }
});

test("startup removes legacy plaintext calendar tokens and leaves both providers disconnected", (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openh-calendar-legacy-"));
  const first = createDb(t, directory);
  if (!first) return;
  first.db.prepare(
    "INSERT INTO google_calendar_tokens (google_email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?)"
  ).run("google@example.com", "legacy-google-access", "legacy-google-refresh", Date.now(), "calendar");
  first.db.prepare(
    "INSERT INTO microsoft_calendar_tokens (microsoft_email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?)"
  ).run("microsoft@example.com", "legacy-ms-access", "legacy-ms-refresh", Date.now(), "calendar");
  first.db.close();

  const reopened = createDb(t, directory);
  if (!reopened) return;
  assert.deepEqual(reopened.getGoogleAccounts(), []);
  assert.deepEqual(reopened.getMicrosoftAccounts(), []);
  for (const token of ["legacy-google-access", "legacy-google-refresh", "legacy-ms-access", "legacy-ms-refresh"]) {
    assert.equal(includesSecret(directory, token), false);
  }
  reopened.db.close();
});

function appleEvent(id: string, overrides: Record<string, unknown> = {}): import("../../src/helpers/database.js").CalendarEventInput {
  return {
    id,
    calendar_id: "apple-calendar",
    provider: "apple",
    summary: id,
    start_time: "2026-07-20T10:00:00Z",
    end_time: "2026-07-20T11:00:00Z",
    is_all_day: false,
    status: "confirmed",
    ...overrides,
  };
}

test("Apple snapshots retain events referenced by meeting notes", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  db.upsertCalendarEvents([appleEvent("linked-event"), appleEvent("unlinked-event")]);
  const note = db.saveNote("Linked meeting", "", "meeting").note;
  db.updateNote(note!.id, { calendar_event_id: "linked-event" });

  db.replaceAppleCalendarEvents([]);

  assert.equal(db.getCalendarEventById("linked-event")?.summary, "linked-event");
  assert.equal(db.getCalendarEventById("unlinked-event"), null);
  db.db.close();
});

function restEvent(provider: string, calendarId: string, id: string, overrides: Record<string, unknown> = {}): import("../../src/helpers/database.js").CalendarEventInput {
  return {
    id,
    calendar_id: calendarId,
    provider,
    summary: id,
    start_time: "2026-07-22T10:00:00Z",
    end_time: "2026-07-22T11:00:00Z",
    is_all_day: false,
    status: "confirmed",
    ...overrides,
  };
}

test("full-sync prune drops stale events but keeps fresh, note-linked, and other-scope rows", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("microsoft", "ms-cal", "fresh"),
    restEvent("microsoft", "ms-cal", "stale"),
    restEvent("microsoft", "ms-cal", "stale-linked"),
    restEvent("microsoft", "other-cal", "other-calendar"),
    restEvent("google", "ms-cal", "other-provider"),
  ]);
  const note = db.saveNote("Linked meeting", "", "meeting").note;
  db.updateNote(note!.id, { calendar_event_id: "stale-linked" });

  db.removeStaleCalendarEvents("microsoft", "ms-cal", ["fresh"]);

  assert.equal(db.getCalendarEventById("fresh")?.summary, "fresh");
  assert.equal(db.getCalendarEventById("stale"), null);
  assert.equal(db.getCalendarEventById("stale-linked")?.summary, "stale-linked");
  assert.equal(db.getCalendarEventById("other-calendar")?.summary, "other-calendar");
  assert.equal(db.getCalendarEventById("other-provider")?.summary, "other-provider");
  db.db.close();
});

test("full-sync prune with an empty fresh set clears the calendar's unlinked events", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  db.upsertCalendarEvents([restEvent("microsoft", "ms-cal", "stale")]);

  db.removeStaleCalendarEvents("microsoft", "ms-cal", []);

  assert.equal(db.getCalendarEventById("stale"), null);
  db.db.close();
});

test("tentative Apple events remain visible in upcoming meetings", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  db.db.prepare("INSERT INTO apple_calendars (id, title) VALUES (?, ?)").run("apple-calendar", "Apple");
  const now = Date.now();
  db.upsertCalendarEvents([
    appleEvent("tentative-event", {
      start_time: new Date(now + 5 * 60_000).toISOString(),
      end_time: new Date(now + 35 * 60_000).toISOString(),
      status: "tentative",
    }),
  ]);

  const events = db.getUpcomingEvents(15);
  assert.equal(
    events.some((event: { id: string }) => event.id === "tentative-event"),
    true
  );
  db.db.close();
});

function insertCalendar(db: DbUnderTest, provider: string, id: string, selected = 1) {
  const table = provider === "google" ? "google_calendars" : "microsoft_calendars";
  db.db
    .prepare(
      `INSERT INTO ${table} (id, summary, is_selected, is_primary, account_email) VALUES (?, ?, ?, 1, ?)`
    )
    .run(id, id, selected, `${provider}@example.com`);
}

test("calendar availability fields are persisted with events", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "free-declined", {
      availability_status: "free",
      self_response_status: "declined",
    }),
  ]);

  const event = db.getCalendarEventById("free-declined");
  assert.equal(event!.availability_status, "free");
  assert.equal(event!.self_response_status, "declined");
  db.db.close();
});

test("upsertCalendarEvents round-trips event_url and defaults it to null", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "with-url", {
      event_url: "https://www.google.com/calendar/event?eid=with-url",
    }),
    restEvent("google", "google-calendar", "without-url"),
  ]);

  assert.equal(
    db.getCalendarEventById("with-url")!.event_url,
    "https://www.google.com/calendar/event?eid=with-url"
  );
  assert.equal(db.getCalendarEventById("without-url")!.event_url, null);
  db.db.close();
});

test("Google People names and photos outrank calendar names and survive later calendar syncs", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  db.upsertContacts([{ email: "Eli.Rum@x.com", displayName: "eli" }]);
  db.upsertGooglePeople([{ email: "eli.rum@x.com", displayName: "Eli Rum", photoUrl: "https://lh3/eli.jpg" }]);
  // A calendar sync after the People sync must not undo it.
  db.upsertContacts([{ email: "eli.rum@x.com", displayName: "eli (invite)" }]);
  // A People profile without a photo keeps the stored one.
  db.upsertGooglePeople([{ email: "eli.rum@x.com", displayName: "Eli Rum", photoUrl: null }]);

  assert.deepEqual(db.getContactProfiles(["ELI.RUM@x.com", "nobody@x.com"]).map((row) => ({ ...row })), [
    { email: "eli.rum@x.com", display_name: "Eli Rum", photo_url: "https://lh3/eli.jpg" },
  ]);
  assert.equal(db.searchContacts("Eli R")[0]?.display_name, "Eli Rum");
  db.db.close();
});

test("upsertCalendarEvents round-trips the description and defaults it to null", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "with-description", { description: "Agenda\n• Intro" }),
    restEvent("google", "google-calendar", "without-description"),
  ]);

  assert.equal(db.getCalendarEventById("with-description")!.description, "Agenda\n• Intro");
  assert.equal(db.getCalendarEventById("without-description")!.description, null);
  db.db.close();
});

test("availability range query uses overlap boundaries and selected calendars", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;
  insertCalendar(db, "google", "selected-google");
  insertCalendar(db, "google", "hidden-google", 0);
  insertCalendar(db, "microsoft", "selected-microsoft");

  db.upsertCalendarEvents([
    restEvent("google", "selected-google", "ends-at-start", {
      start_time: "2026-07-22T09:00:00Z",
      end_time: "2026-07-22T10:00:00Z",
    }),
    restEvent("google", "selected-google", "overlaps", {
      start_time: "2026-07-22T09:30:00Z",
      end_time: "2026-07-22T10:30:00Z",
    }),
    restEvent("google", "hidden-google", "deselected", {
      start_time: "2026-07-22T10:15:00Z",
      end_time: "2026-07-22T10:45:00Z",
    }),
    restEvent("microsoft", "selected-microsoft", "other-provider", {
      start_time: "2026-07-22T10:15:00Z",
      end_time: "2026-07-22T10:45:00Z",
    }),
  ]);

  const events = db.getCalendarEventsInRange("2026-07-22T10:00:00Z", "2026-07-22T11:00:00Z", [
    "google",
  ]);
  assert.deepEqual(
    events.map((event: { id: string }) => event.id),
    ["overlaps"]
  );
  db.db.close();
});

test("availability range query treats date-only all-day events as local dates", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;
  db.db
    .prepare("INSERT INTO apple_calendars (id, title) VALUES (?, ?)")
    .run("apple-calendar", "Apple");
  db.upsertCalendarEvents([
    appleEvent("all-day", {
      start_time: "2026-07-22",
      end_time: "2026-07-23",
      is_all_day: true,
    }),
  ]);

  const events = db.getCalendarEventsInRange(
    new Date(2026, 6, 22, 9).toISOString(),
    new Date(2026, 6, 22, 18).toISOString(),
    ["apple"]
  );
  assert.deepEqual(
    events.map((event: { id: string }) => event.id),
    ["all-day"]
  );
  db.db.close();
});

test("google sync token persists alongside its expiry", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");

  const expiresAt = Date.parse("2026-07-23T10:00:00Z");
  db.updateCalendarSyncToken("google-calendar", "sync-token", expiresAt, "google@example.com");

  const calendar = db.getGoogleCalendars().find((row) => row.id === "google-calendar");
  assert.equal(calendar!.sync_token, "sync-token");
  assert.equal(calendar!.sync_token_expires_at, expiresAt);
  db.db.close();
});

test("removing an account excludes only its events from live queries and keeps by-ID history", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  insertCalendar(db, "google", "a-calendar");
  insertCalendar(db, "google", "b-calendar");
  db.db.prepare("UPDATE google_calendars SET account_email = 'b@example.com' WHERE id = 'b-calendar'").run();
  const future = {
    start_time: new Date(Date.now() + 5 * 60_000).toISOString(),
    end_time: new Date(Date.now() + 35 * 60_000).toISOString(),
  };
  db.upsertCalendarEvents([
    restEvent("google", "a-calendar", "a-event", future),
    restEvent("google", "b-calendar", "b-event", future),
  ]);

  db.removeGoogleAccount("google@example.com");

  assert.equal(db.getUpcomingEvents(60).some((e: { id: string }) => e.id === "a-event"), false);
  assert.equal(db.getUpcomingEvents(60).some((e: { id: string }) => e.id === "b-event"), true);
  assert.equal(db.getActiveEvents().some((e: { id: string }) => e.id === "a-event"), false);
  // Note-linked history stays available by ID.
  assert.equal(db.getCalendarEventById("a-event")?.summary, "a-event");
  db.db.close();
});

test("after the last account is removed no orphaned events reach live queries", (t: import("node:test").TestContext) => {
  const db = createDb(t) as DbUnderTest;
  if (!db) return;

  insertCalendar(db, "microsoft", "ms-calendar");
  const future = {
    start_time: new Date(Date.now() + 5 * 60_000).toISOString(),
    end_time: new Date(Date.now() + 35 * 60_000).toISOString(),
  };
  db.upsertCalendarEvents([restEvent("microsoft", "ms-calendar", "ms-event", future)]);
  assert.equal(db.getUpcomingEvents(60).length, 1);

  db.removeMicrosoftAccount("microsoft@example.com");

  assert.equal(db.getUpcomingEvents(60).length, 0);
  assert.equal(db.getActiveEvents().length, 0);
  db.db.close();
});

// A request belongs to the connection that started it, including when a new
// connection uses the same email. Exercise the real encrypted SQLite store.
for (const provider of ["google", "microsoft"] as const) {
  for (const reconnect of [false, true]) {
    for (const operation of ["refresh", "list", "events"] as const) {
      test(`${provider} late ${operation} cannot restore or overwrite ${reconnect ? "reconnected" : "disconnected"} account`, async (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gm-calendar-identity-"));
        let db = createDb(t, directory);
        t.after(() => { db?.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
        if (!db) return;
        const email = "account@example.com";
        const save = (access: string) => {
          const values = { access_token: access, refresh_token: `${access}-refresh`, expires_at: 0, scope: "calendar" };
          if (provider === "google") db!.saveGoogleTokens({ ...values, google_email: email });
          else db!.saveMicrosoftTokens({ ...values, microsoft_email: email });
        };
        const read = () => provider === "google" ? db!.getGoogleTokensByEmail(email) : db!.getMicrosoftTokensByEmail(email);
        save("old");
        const oldId = read()!.id;
        const CalendarManager = require(`../../src/helpers/${provider}CalendarManager.ts`);
        const scheduler = { scheduleNextMeeting() {}, reset() {}, reconcileProvider() {} };
        const manager = provider === "google" ? new CalendarManager(db, null, scheduler) : new CalendarManager(db, scheduler);
        t.after(() => manager.stop());
        manager.addAccount(email);
        let resolve!: (result: unknown) => void;
        const response = new Promise((done) => { resolve = done; });
        let request: Promise<unknown>;
        if (operation === "refresh") {
          manager.oauth.refreshAccessToken = () => response;
          request = manager.oauth.getValidAccessToken(email);
        } else {
          manager._apiGet = () => response;
          if (operation === "list") request = manager.fetchCalendars(email);
          else {
            const calendar = { id: "shared-calendar", summary: "Old calendar", account_email: email };
            if (provider === "google") db.saveGoogleCalendars([calendar], email);
            else db.saveMicrosoftCalendars([calendar], email);
            request = manager.syncEvents();
          }
        }
        // Observe rejection immediately so the controlled response never
        // causes an unhandled rejection before the test awaits it.
        const settled = request.then((value) => ({ value }), (error: Error) => ({ error }));
        manager.disconnect(email);
        if (reconnect) {
          save("new");
          assert.notEqual(read()!.id, oldId);
          manager.addAccount(email);
          const calendar = { id: "shared-calendar", summary: "New calendar", is_primary: true };
          if (provider === "google") db.saveGoogleCalendars([calendar], email);
          else db.saveMicrosoftCalendars([calendar], email);
        }
        const event = { id: "late-event", summary: "Old", subject: "Old", start: { dateTime: "2026-10-05T10:00:00Z" }, end: { dateTime: "2026-10-05T11:00:00Z" } };
        resolve(operation === "refresh" ? { access_token: "late", refresh_token: "late-refresh", expires_in: 3600 } : provider === "google" ? { items: operation === "list" ? [{ id: "shared-calendar", summary: "Old calendar", primary: true }] : [event] } : { value: operation === "list" ? [{ id: "shared-calendar", name: "Old calendar", isDefaultCalendar: true }] : [event] });
        const result = await settled;
        if (operation === "refresh") assert.ok("error" in result);
        assert.equal(read()?.access_token ?? null, reconnect ? "new" : null);
        const calendars = db.db.prepare(`SELECT * FROM ${provider}_calendars`).all() as Array<{ summary: string }>;
        assert.deepEqual(calendars.map(row => row.summary), reconnect ? ["New calendar"] : []);
        assert.equal(db.getCalendarEventById("late-event"), null);
        db.db.close(); db = null;
        db = createDb(t, directory);
        assert.ok(db);
        assert.equal(read()?.access_token ?? null, reconnect ? "new" : null);
        assert.equal(provider === "google" ? db.getGoogleAccounts().length > 0 : db.getMicrosoftAccounts().length > 0, reconnect);
      });
    }
  }
  test(`${provider} refresh deduplicates per connection and preserves token rotation`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gm-calendar-rotation-"));
    const db = createDb(t, directory);
    t.after(() => { db?.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    if (!db) return;
    const email = "account@example.com";
    const values = { access_token: "old", refresh_token: "old-refresh", expires_at: 0, scope: "calendar" };
    const save = () => provider === "google" ? db.saveGoogleTokens({ ...values, google_email: email }) : db.saveMicrosoftTokens({ ...values, microsoft_email: email });
    const read = () => provider === "google" ? db.getGoogleTokensByEmail(email) : db.getMicrosoftTokensByEmail(email);
    save();
    const OAuth = require(`../../src/helpers/${provider}CalendarOAuth.ts`);
    const oauth = new OAuth(db);
    const resolvers: Array<(value: unknown) => void> = [];
    oauth.refreshAccessToken = () => new Promise(resolve => resolvers.push(resolve));
    const stale = oauth.getValidAccessToken(email).catch((error: Error) => error);
    const oldId = read()!.id;
    save(); // Intentional reauthorization without an intervening disconnect.
    assert.notEqual(read()!.id, oldId);
    const first = oauth.getValidAccessToken(email);
    const second = oauth.getValidAccessToken(email);
    assert.equal(resolvers.length, 2, "new connection does not join old refresh; its own requests share one");
    resolvers[0]({ access_token: "stale", expires_in: 3600 });
    assert.ok(await stale instanceof Error);
    // Old settlement must not evict the newer connection's pending refresh.
    const third = oauth.getValidAccessToken(email);
    assert.equal(resolvers.length, 2);
    resolvers[1]({ access_token: "current", refresh_token: "rotated", expires_in: 3600, scope: "calendar-new" });
    assert.deepEqual(await Promise.all([first, second, third]), ["current", "current", "current"]);
    assert.equal(read()!.refresh_token, "rotated");
    assert.equal(read()!.scope, "calendar-new");
    assert.equal(await oauth.getValidAccessToken(email), "current");
    assert.equal(resolvers.length, 2);
  });
}

for (const provider of ["google", "microsoft"] as const) {
  for (const final of [false, true]) {
    test(`${provider} ${final ? "final" : "non-final"} removal cannot attach its cached event to a new capture Note`, async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gm-calendar-disconnect-"));
      const db = createDb(t, directory);
      t.after(() => { db?.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
      if (!db) return;
      const accounts = final ? ["a@example.com"] : ["a@example.com", "b@example.com"];
      for (const email of accounts) {
        const values = { access_token: "test", refresh_token: "refresh", expires_at: 0, scope: "calendar" };
        const calendar = { id: email, summary: email, is_primary: true };
        if (provider === "google") {
          db.saveGoogleTokens({ ...values, google_email: email });
          db.saveGoogleCalendars([calendar], email);
        } else {
          db.saveMicrosoftTokens({ ...values, microsoft_email: email });
          db.saveMicrosoftCalendars([calendar], email);
        }
        db.upsertCalendarEvents([{ id: email, calendar_id: email, provider,
          summary: `private ${email}`, attendees_count: 1, attendees: JSON.stringify([{ email, displayName: email }]),
          start_time: new Date(Date.now() - (email.startsWith("a@") ? 30_000 : 60_000)).toISOString(), end_time: new Date(Date.now() + 3_600_000).toISOString(),
        }]);
      }
      const Scheduler = require("../../src/helpers/calendarReminderScheduler.ts");
      const scheduler = new Scheduler(db);
      t.after(() => scheduler.stop());
      let reminders = 0;
      scheduler.meetingDetectionEngine = { handleCalendarReminder: () => { reminders++; } };
      scheduler.scheduleNextMeeting();
      const a = db.getCalendarEventById("a@example.com")!;
      assert.equal(scheduler.getActiveMeetingState().activeMeeting?.id, a.id, "eligible A is cached before disconnect");
      assert.equal(reminders, accounts.length, "A and each remaining account already delivered a reminder");
      const baseline = reminders;
      const Manager = require(`../../src/helpers/${provider}CalendarManager.ts`);
      const manager = provider === "google" ? new Manager(db, null, scheduler) : new Manager(db, scheduler);
      t.after(() => manager.stop());
      for (const email of accounts) manager.addAccount(email);
      manager.removeAccount("a@example.com");
      assert.equal(scheduler.getActiveMeetingState().activeMeeting, null);
      assert.equal(reminders, baseline, "remaining account's delivered reminder is not repeated");
      const Detection = require("../../src/helpers/meetingDetectionEngine.ts");
      let noteId: number | undefined;
      const { EventEmitter } = require("node:events");
      const engine = new Detection(scheduler, new EventEmitter(), Object.assign(new EventEmitter(), { resetPrompt() {} }), {
        notificationPrefs: {}, dismissMeetingNotification() {},
        showMeetingNotification: async () => true,
        queueMeetingNoteNavigation: async (request: { noteId: number }) => { noteId = request.noteId; },
      }, db);
      assert.equal(engine._findCalendarEvent(), null);
      engine.activeDetections.set("audio:test", { source: "audio", key: "test" });
      engine._showPrompt("audio:test", "audio", "test", { service: "zoom" });
      await engine.handleNotificationResponse("audio:test", "start");
      assert.ok(noteId);
      const note = db.getNote(noteId!);
      assert.notEqual(note?.title, a.summary);
      assert.equal(note?.calendar_event_id, null);
      assert.equal(note?.participants, null);
    });
  }
}

for (const remove of ["a@example.com", "b@example.com"]) {
  test(`shared Google calendar keeps account selection and survives disconnect ${remove}`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gm-shared-google-"));
    let db = createDb(t, directory);
    t.after(() => { db?.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    if (!db) return;
    for (const email of ["a@example.com", "b@example.com"]) {
      db.saveGoogleTokens({ google_email: email, access_token: "test", refresh_token: "refresh", expires_at: 0, scope: "calendar" });
      db.saveGoogleCalendars([{ id: "shared", summary: "Shared", is_primary: email === "a@example.com" }], email);
    }
    db.db.prepare("INSERT INTO google_calendars(id, summary, is_primary, is_selected) VALUES (?, ?, 1, 1)").run("shared", "Ownerless historical row");
    db.applyPrimaryOnlyToSelection(true);
    assert.equal(db.getGoogleCalendars("a@example.com")[0].is_selected, 1);
    assert.equal(db.getGoogleCalendars("b@example.com")[0].is_selected, 0);
    assert.equal(db.getSelectedCalendars().length, 1);
    assert.equal(db.getSelectedCalendars()[0].account_email, "a@example.com");
    db.updateCalendarSyncToken("shared", "a-token", Date.now() + 60_000, "a@example.com");
    assert.equal(db.getGoogleCalendars("b@example.com")[0].sync_token, null);
    // Explicit shared selection makes the secondary association eligible too.
    db.updateCalendarSelection("shared", true);
    assert.equal(db.getSelectedCalendars().length, 1, "sync uses one eligible association per calendar");
    const event = { id: "shared-event", calendar_id: "shared", provider: "google",
      summary: "Shared meeting", attendees_count: 1,
      start_time: new Date(Date.now() - 60_000).toISOString(), end_time: new Date(Date.now() + 60_000).toISOString() };
    db.upsertCalendarEvents([event]);
    const note = db.saveNote("Historical", "", "meeting").note!;
    db.updateNote(note.id, { calendar_event_id: event.id });
    db.db.close(); db = createDb(t, directory)!;
    assert.equal(db.getGoogleCalendars("a@example.com")[0].sync_token, "a-token");
    assert.equal(db.getGoogleCalendars("b@example.com")[0].is_selected, 1);
    db.removeGoogleAccount(remove);
    assert.equal(db.getSelectedCalendars().length, 1);
    assert.equal(db.getSelectedCalendars()[0].account_email, remove === "a@example.com" ? "b@example.com" : "a@example.com");
    assert.equal(db.getActiveEvents()[0].id, event.id);
    assert.equal(db.getNote(note.id)!.calendar_event_id, event.id);
    db.removeGoogleAccount(remove === "a@example.com" ? "b@example.com" : "a@example.com");
    assert.deepEqual(db.getActiveEvents(), []);
    assert.deepEqual(db.getSelectedCalendars(), [], "an ownerless row cannot replace a connected association");
    assert.equal(db.getCalendarEventById(event.id)!.summary, event.summary, "history stays readable");
  });
}

test("Google calendar schema cutover preserves selection, sync and Note history on reopen", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gm-google-migration-"));
  let db = createDb(t, directory);
  t.after(() => { db?.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  if (!db) return;
  db.db.exec(`DROP TABLE google_calendars; CREATE TABLE google_calendars (
    id TEXT PRIMARY KEY, summary TEXT NOT NULL, description TEXT, background_color TEXT,
    is_selected INTEGER NOT NULL DEFAULT 1, is_primary INTEGER NOT NULL DEFAULT 0,
    sync_token TEXT, sync_token_expires_at INTEGER, account_email TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ); INSERT INTO google_calendars(id,summary,is_selected,is_primary,sync_token,account_email)
    VALUES ('legacy','Legacy',0,1,'old-token','a@example.com')`);
  const note = db.saveNote("History", "", "meeting").note!;
  db.upsertCalendarEvents([{ id: "legacy-event", calendar_id: "legacy", summary: "Legacy event",
    start_time: new Date().toISOString(), end_time: new Date(Date.now()+60_000).toISOString() }]);
  db.updateNote(note.id, { calendar_event_id: "legacy-event" });
  db.db.close(); db = createDb(t, directory)!;
  const row = db.getGoogleCalendars("a@example.com")[0];
  assert.equal(row.is_selected, 0);
  assert.equal(row.is_primary, 1);
  assert.equal(row.sync_token, "old-token");
  assert.equal(db.getNote(note.id)!.calendar_event_id, "legacy-event");
  assert.equal(db.getCalendarEventById("legacy-event")!.summary, "Legacy event");
  db.saveGoogleCalendars([{ id: "legacy", summary: "Other subscription", is_primary: false }], "b@example.com");
  assert.equal(db.getGoogleCalendars("a@example.com")[0].summary, "Legacy");
  assert.equal(db.getGoogleCalendars("b@example.com").length, 1);
});
