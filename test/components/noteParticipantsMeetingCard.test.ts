const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const { createElement } = require("react");

const { renderToStaticMarkup } = require("react-dom/server");

const {
  createRendererServer,
  installBrowserGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

type TestContext = import("node:test").TestContext;

const heroMock = `
import React from "react";
const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
export const Popover = Object.assign(passthrough, { Content: passthrough, Dialog: passthrough });
export const Pressable = passthrough;
`;

function makeEvent(overrides = {}) {
  return {
    id: "evt-1",
    calendar_id: "cal-1",
    provider: "google",
    summary: "Synthetic Team Meeting",
    start_time: "2026-09-23T19:00:00Z",
    end_time: "2026-09-23T20:00:00Z",
    is_all_day: 0,
    status: "confirmed",
    availability_status: "busy",
    self_response_status: "accepted",
    hangout_link: "https://meet.google.com/abc-defg-hij",
    conference_data: null,
    event_url: "https://www.google.com/calendar/event?eid=abc",
    organizer_email: null,
    attendees_count: 1,
    attendees: null,
    description: null,
    ...overrides,
  };
}

async function renderCard(t: TestContext, props: Record<string, unknown>) {
  installBrowserGlobals(t, {
    window: { electronAPI: { searchContacts: async () => ({ success: true, contacts: [] }) } },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-participants-",
    noExternal: ["@heroui/react", "react-i18next"],
    mockModules: {
      "@heroui/react": heroMock,
      "react-i18next": `export function useTranslation() { return { t: (key, options) => typeof options === "string" ? options : options?.defaultValue ?? key }; }`,
      "/stores/meetingRecordingStore": `export const syncSessionExpectedCountFromParticipants = () => {};`,
      "/hooks/useUiLocale": `export function useUiLocale() { return "en"; }`,
      "/hooks/useDateTimePreferences": `export function useDateTimePreferences() { return { dateFormat: "locale", timeFormat: "locale" }; }`,
      "/hooks/usePersonProfile": `export function usePersonProfile(){return null;} export function usePersonName(email, name){return name || email;} export function refreshPersonProfile(){return Promise.resolve();}`,
    },
  });

  const mod = await vite.ssrLoadModule("/components/notes/NoteParticipants.tsx");

  return renderToStaticMarkup(
    createElement(mod.default, { noteId: 1, participants: [], canRenameContacts: true, ...props })
  );
}

test("a linked event shows its title, join button and calendar button", async (t: TestContext) => {
  const html = await renderCard(t, { event: makeEvent() });

  assert.match(html, /Synthetic Team Meeting/, "synthetic event title");
  assert.match(html, /meet\.google\.com\/abc-defg-hij/, "join link");
  assert.match(html, /notes\.participants\.calendar/, "calendar button");
});

test("an unlinked note keeps participant editing with no empty link or calendar blocks", async (t: TestContext) => {
  const html = await renderCard(t, { event: null });

  assert.match(html, /Add attendees/, "attendee search stays available");
  assert.doesNotMatch(html, /notes\.participants\.calendar/, "no calendar button");
  assert.doesNotMatch(html, /meet\.google\.com/, "no join link");
});

test("a missing event_url hides the calendar button but keeps the join link", async (t: TestContext) => {
  const html = await renderCard(t, { event: makeEvent({ event_url: null }) });

  assert.match(html, /meet\.google\.com\/abc-defg-hij/, "join link survives");
  assert.doesNotMatch(
    html,
    /notes\.participants\.calendar/,
    "calendar button hidden without event_url"
  );
});

test("an event description shows as a preview and stays hidden when absent", async (t: TestContext) => {
  const withDescription = await renderCard(t, {
    event: makeEvent({ description: "Agenda: roadmap review" }),
  });

  assert.match(withDescription, /Agenda: roadmap review/, "description preview");

  const without = await renderCard(t, { event: makeEvent() });
  assert.doesNotMatch(without, /notes\.participants\.description/, "no empty description block");
});

test("an external calendar preview stays read-only until contacts are materialized", async (t: TestContext) => {
  const draft = {
    noteId: 0,
    preview: true,
    participants: [{ email: "test@example.com", displayName: "Test", self: false, responseStatus: null }],
    event: makeEvent(),
  };
  const editable = await renderCard(t, { ...draft, canRenameContacts: true });
  assert.doesNotMatch(editable, /aria-label="Rename contact"/,
    "external attendee attributes do not create a local contact during render");
  const debug = await renderCard(t, { ...draft, canRenameContacts: false });
  assert.doesNotMatch(debug, /aria-label="Rename contact"/,
    "synthetic debug contacts cannot change the stored contacts");
});
