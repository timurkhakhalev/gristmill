const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

// Compiles a probe source under the strict main settings and returns all
// program diagnostics. Negative probes expect specific codes; positive
// probes expect none.
function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "calendar-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

const IPC_MAIN = `declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };`;

test("incomplete manager wiring fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerCalendarIntegrationHandlers } from "./src/helpers/calendarIpcHandlers.ts";

${IPC_MAIN}

// Missing getUpcomingEvents/getCalendarEventById and the Apple manager would
// silently break the neutral reads; the compiler must reject the registration.
registerCalendarIntegrationHandlers(ipcMain, {
  googleManager: {
    startOAuth: async () => ({ success: true, email: "g@x.io" }),
    disconnect: () => {},
    getConnectionStatus: () => ({ connected: false, email: null }),
    getCalendars: () => [],
    setCalendarSelection: async () => {},
    setPrimaryOnly: async () => {},
    syncEvents: async () => {},
  },
  microsoftManager: {
    startOAuth: async () => ({ success: true }),
    disconnect: () => {},
    getConnectionStatus: () => ({ connected: false, accounts: [] }),
    setPrimaryOnly: async () => {},
  },
  openCalendarPrivacySettings: async () => ({ success: true }),
  logError: () => {},
});
`);
  try {
    assert.ok(codes.length > 0, "missing dependencies must not compile");
    assert.ok(
      codes.some((code) => [2322, 2345, 2739, 2741].includes(code)),
      `expected a property/argument diagnostic, got ${codes.join(",")}`
    );
  } finally {
    cleanup();
  }
});

test("wrong command args, results and event payloads fail compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { createCalendarIntegrationBridge } from "./src/preload/calendarBridge.ts";
import { googleConnectionStatusSchema } from "./src/contracts/calendar.ts";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};
const bridge = createCalendarIntegrationBridge(ipcRendererLike);

// windowMinutes is a positive integer; a string is a compile-time error.
bridge.gcalGetUpcomingEvents("60");

// The event lookup takes an id, not a number.
bridge.gcalGetEvent(42);

// The Apple status event sourceNames is a string array, not a number.
bridge.onAcalConnectionChanged((data) => {
  const names: number = data.sourceNames;
  void names;
});

async function failureArm(): Promise<string> {
  const status = await bridge.gcalStartOAuth();
  if (status.success === false) {
    // email only exists on the success arm.
    return status.email;
  }
  return status.email;
}
void failureArm;

// Status parsing keeps absence-vs-false: configured stays optional.
const parsed = googleConnectionStatusSchema.parse({ connected: false, email: null });
const configured: boolean = parsed.configured;
void configured;
`);
  try {
    assert.ok(codes.includes(2345), `wrong arguments must fail, got ${codes.join(",")}`);
    assert.ok(codes.includes(2339), `failure-arm/event usage must fail, got ${codes.join(",")}`);
    assert.ok(codes.includes(2322), `optional-field misuse must fail, got ${codes.join(",")}`);
  } finally {
    cleanup();
  }
});

test("the full registration, bridge and contract compile under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerCalendarIntegrationHandlers } from "./src/helpers/calendarIpcHandlers.ts";
import { createCalendarIntegrationBridge } from "./src/preload/calendarBridge.ts";
import {
  projectCalendarEvent,
  projectGoogleCalendarSummary,
  googleConnectionStatusSchema,
  type CalendarEvent,
} from "./src/contracts/calendar.ts";

${IPC_MAIN}

registerCalendarIntegrationHandlers(ipcMain, {
  googleManager: {
    startOAuth: async () => ({ success: true, email: "g@x.io" }),
    disconnect: (email?: string) => {
      void email;
    },
    getConnectionStatus: () => ({ connected: true, email: "g@x.io", configured: true }),
    getCalendars: () => [],
    setCalendarSelection: async (calendarId: string, isSelected: boolean) => {
      void calendarId;
      void isSelected;
    },
    setPrimaryOnly: async (value: boolean) => {
      void value;
    },
    syncEvents: async () => {},
  },
  microsoftManager: {
    startOAuth: async () => ({ success: true, email: "m@x.io" }),
    disconnect: () => {},
    getConnectionStatus: () => ({ connected: false, accounts: [] }),
    setPrimaryOnly: async () => {},
  },
  appleManager: {
    connect: async () => ({ success: true }),
    disconnect: () => ({ success: true }),
    getConnectionStatus: () => ({ connected: false, sourceNames: [] }),
  },
  getUpcomingEvents: async () => [{ id: "e", calendar_id: "c", provider: "google", summary: null, start_time: "2026-09-15", end_time: "2026-09-15", is_all_day: 0, status: "confirmed", availability_status: "unknown", self_response_status: "unknown", hangout_link: null, conference_data: null, organizer_email: null, attendees_count: 0, attendees: null, synced_at: "x" }],
  getCalendarEventById: () => null,
  openCalendarPrivacySettings: async () => ({ success: true }),
  logError: () => {},
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};
const bridge = createCalendarIntegrationBridge(ipcRendererLike);

async function useAll(): Promise<string> {
  const oauth = await bridge.gcalStartOAuth();
  await bridge.gcalDisconnect("g@x.io");
  const status = await bridge.gcalGetConnectionStatus();
  const calendars = await bridge.gcalGetCalendars();
  await bridge.gcalSetCalendarSelection("cal-1", true);
  await bridge.gcalSetPrimaryOnly(false);
  await bridge.gcalSyncEvents();
  const upcoming = await bridge.gcalGetUpcomingEvents(60);
  const single = await bridge.gcalGetEvent("evt-1");
  const mstatus = await bridge.mcalGetConnectionStatus();
  const astatus = await bridge.acalGetConnectionStatus();
  await bridge.acalConnect();
  await bridge.acalDisconnect();
  await bridge.openCalendarPrivacySettings();
  const unsubAccounts = bridge.onGcalConnectionChanged((data) => {
    void data.accounts;
  });
  const unsubSynced = bridge.onGcalEventsSynced(() => {});
  unsubAccounts();
  unsubSynced();
  return [
    oauth.success ? "ok" : "no",
    String(status.connected),
    String(calendars.calendars.length),
    String(upcoming.events.length),
    single.event === null ? "none" : "some",
    String(mstatus.connected),
    String(astatus.sourceNames.length),
  ].join();
}
void useAll;

// The projection drops internals and keeps consumer fields at the type level.
const projected = projectCalendarEvent({ id: "e", calendar_id: "c", provider: "google", summary: null, start_time: "s", end_time: "e", is_all_day: 0, status: "confirmed", availability_status: "busy", self_response_status: "accepted", hangout_link: null, conference_data: null, organizer_email: null, attendees_count: 1, attendees: null, synced_at: "internal" });
const wire: CalendarEvent | null = projected;
void wire;
void projectGoogleCalendarSummary;
void googleConnectionStatusSchema;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
