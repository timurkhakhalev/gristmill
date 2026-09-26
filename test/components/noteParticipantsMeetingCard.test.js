const assert = require("node:assert/strict");
const test = require("node:test");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const heroMock = `
import React from "react";
const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
export const Popover = Object.assign(passthrough, { Content: passthrough, Dialog: passthrough });
export const Pressable = passthrough;
`;

function event(overrides = {}) {
  return {
    id: "evt-1",
    calendar_id: "cal-1",
    provider: "google",
    summary: "Vol.44 call LLM Neighbors",
    start_time: "2026-09-23T19:00:00Z",
    end_time: "2026-09-23T20:00:00Z",
    is_all_day: 0,
    status: "confirmed",
    availability_status: "busy",
    self_response_status: "accepted",
    hangout_link: "https://meet.google.com/xng-tmak-ich",
    conference_data: null,
    event_url: "https://www.google.com/calendar/event?eid=abc",
    organizer_email: null,
    attendees_count: 1,
    attendees: null,
    ...overrides,
  };
}

async function renderCard(t, props) {
  installBrowserGlobals(t, {
    window: { electronAPI: { searchContacts: async () => ({ success: true, contacts: [] }) } },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-participants-",
    noExternal: ["@heroui/react"],
    mockModules: {
      "@heroui/react": heroMock,
      "react-i18next": `export function useTranslation() { return { t: (key, options) => options?.defaultValue ?? key }; }`,
      "/stores/meetingRecordingStore": `export const syncSessionExpectedCountFromParticipants = () => {};`,
      "/hooks/useUiLocale": `export function useUiLocale() { return "en"; }`,
    },
  });
  const mod = await vite.ssrLoadModule("/components/notes/NoteParticipants.tsx");
  return renderToStaticMarkup(
    createElement(mod.default, { noteId: 1, participants: [], ...props })
  );
}

test("a linked event shows its title, join link and calendar button", async (t) => {
  const html = await renderCard(t, { event: event() });

  assert.match(html, /Vol\.44 call LLM Neighbors/, "real event title");
  assert.match(html, /meet\.google\.com\/xng-tmak-ich/, "join link");
  assert.match(html, /Open in calendar/, "calendar button");
});

test("an unlinked note keeps participant editing with no empty link or calendar blocks", async (t) => {
  const html = await renderCard(t, { event: null });

  assert.match(html, /Add attendees/, "attendee search stays available");
  assert.doesNotMatch(html, /Open in calendar/, "no calendar button");
  assert.doesNotMatch(html, /meet\.google\.com/, "no join link");
});

test("a missing event_url hides the calendar button but keeps the join link", async (t) => {
  const html = await renderCard(t, { event: event({ event_url: null }) });

  assert.match(html, /meet\.google\.com\/xng-tmak-ich/, "join link survives");
  assert.doesNotMatch(html, /Open in calendar/, "calendar button hidden without event_url");
});
