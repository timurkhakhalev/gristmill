# Home and navigation

As a Gristmill user, I want to find upcoming meetings and return to my notes.

## User journey

1. Complete onboarding and open Home.
2. Review Coming Up and Recent Notes.
3. Open a note, or click a calendar event to open its note or an unsaved event draft.
4. Use the sidebar to open Actions, Upload, Settings or a note in the spaces tree.

## Behavior and limits

- Tray New Note, event and Settings commands wait in preload until ControlPanel subscribes. New Note and event actions also wait for loaded spaces/tree readiness so initial Note selection cannot discard an event draft. The document-load sender guard applies to all three commands; delivering one does not override window visibility.
- Home is the default main view. Notes without a selected note also shows Home.
- Recent Notes fetches up to 50 notes across spaces, selected by last update. The display groups and orders this set by creation time.
- Confirmed note events refresh the recent list, including deletion from a folder that is not loaded.
- Coming Up reads events through midnight seven days ahead and filters for other attendees. It shows at most five days with events, with Today always present.
- Without a connected calendar, Coming Up offers calendar setup.
- Clicking an event row does not start recording. An event draft is saved on the first title/text edit, Record or Ask.
- Join/Take notes is a separate action: it opens the meeting link when present and starts the calendar meeting flow.

Home updates its recent-note state and remount cache only from the current request. A superseded response cannot restore deleted rows on remount.

## What to check

- A deleted note leaves Recent Notes after a confirmed deletion.
- Event selection and Join/Take notes have different effects.

## BDD acceptance criteria

- Given an unloaded folder contains a recent note, when its deletion is confirmed, then Home refreshes its list.
- Given an event has no saved note, when I open its row, then I see an unsaved draft until I edit, record or ask.

## Entry points

- [HomeView.tsx](../../../src/components/home/HomeView.tsx) — Home and recent-note refresh.
- [RecentNotes.tsx](../../../src/components/home/RecentNotes.tsx) — grouping and note actions.
- [ComingUp.tsx](../../../src/components/home/ComingUp.tsx) — calendar display and join action.
- [ControlPanel.tsx](../../../src/components/ControlPanel.tsx) — navigation.
- [EventNoteDraft.tsx](../../../src/components/notes/EventNoteDraft.tsx) — draft persistence.
- [useUpcomingEvents.ts](../../../src/hooks/useUpcomingEvents.ts) — calendar window.
- [database.ts](../../../src/helpers/database.ts) — recent-note selection.
