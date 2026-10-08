import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarEvent } from "../../../../src/contracts/calendar.ts";
import { createRendererServer } from "../../../lib/rendererTestHarness.ts";

test("Coming up explains missing System Audio access while meetings are listed", async (t) => {
  const globals = globalThis as typeof globalThis & { __comingUpAudioGranted?: boolean };
  globals.__comingUpAudioGranted = false;
  t.after(() => delete globals.__comingUpAudioGranted);

  const vite = await createRendererServer(t, {
    cachePrefix: "gristmill-coming-up-audio-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": 'export function useTranslation(){return {t:key=>key};}',
      "/hooks/useSystemAudioPermission":
        'export function useSystemAudioPermission(){return {granted:globalThis.__comingUpAudioGranted,mode:"native",request:async()=>false};}',
      "/hooks/useUiLocale": 'export function useUiLocale(){return "en-US";}',
      "/hooks/useDateTimePreferences":
        'export function useDateTimePreferences(){return {timeFormat:"12h"};}',
      "/ui/popover":
        'import React from "react"; export function Popover({children}){return React.createElement(React.Fragment,null,children);} export const PopoverContent=Popover; export const PopoverTrigger=Popover;',
      "/ui/PersonAvatar": "export default function PersonAvatar(){return null;}",
      "/ui/PersonName": "export default function PersonName(){return null;}",
      "/ui/EmptyStateCard": "export default function EmptyStateCard(){return null;}",
      "/ui/Skeleton": 'export const CONTENT_ENTER_CLASS="";',
      "/home/HomeSkeleton": "export function ComingUpSkeleton(){return null;}",
      "/ui/button":
        'import React from "react"; export function Button({children}){return React.createElement("button",null,children);}',
    },
  });

  const { default: ComingUp } = await vite.ssrLoadModule("/components/home/ComingUp.tsx");
  const event: CalendarEvent = {
    id: "event-1",
    calendar_id: "calendar-1",
    provider: "google",
    summary: "Planning",
    start_time: "2026-10-09T10:00:00Z",
    end_time: "2026-10-09T11:00:00Z",
    is_all_day: 0,
    status: "confirmed",
    availability_status: "busy",
    self_response_status: "accepted",
    hangout_link: null,
    conference_data: null,
    event_url: null,
    organizer_email: null,
    attendees_count: 0,
    attendees: null,
    description: null,
  };
  const props = {
    events: [event],
    isLoading: false,
    isConnected: true,
    onConnectCalendar() {},
    onOpenEvent() {},
  };

  const withoutAccess = renderToStaticMarkup(React.createElement(ComingUp, props));
  assert.match(withoutAccess, /Planning/);
  assert.match(withoutAccess, /upcoming\.systemAudioRequired/);
  assert.match(withoutAccess, /upcoming\.openSettings/);

  globals.__comingUpAudioGranted = true;
  const withAccess = renderToStaticMarkup(React.createElement(ComingUp, props));
  assert.doesNotMatch(withAccess, /upcoming\.systemAudioRequired/);
});
