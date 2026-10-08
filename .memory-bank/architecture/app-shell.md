# Application shell

This document contains the rules of the first-launch gate, tray startup, Home and Settings navigation.
User paths: [First launch](../product/user-journeys/onboarding.md), [Home and navigation](../product/user-journeys/home.md), [Settings](../product/user-journeys/settings.md).

## Onboarding gate

- `AppRouter` keeps the main ControlPanel unavailable until onboarding completes. Completion is stored in localStorage.
- Step order (`OnboardingFlow`): permissions → profile → provider → languages → calendar. The current step is not persisted. An incomplete flow starts again after a restart.
- Microphone access is required to continue. System audio and Accessibility are optional in this flow.
- An empty language selection does not block Continue. Calendar connection is optional.
- Normal Finish opens the main view. The flow does not request automatic Settings opening.
- Calendar setup continues after system audio permission is refused. Settings → Calendar also allows a connection without this permission.

### Provider step

- The provider step configures transcription, not Chat or Summary.
- Its direct picker offers only file models with a working single-key credential handler. AssemblyAI and Corti are excluded from this form.
- A confirmed choice applies through the existing all-scope transcription setter. Meeting still enforces its narrower file-provider capabilities.
- Continue and Proceed share one in-flight secure save. The footer is disabled during that save. A failed save permits Retry.
- A pending secure save may finish. Its result changes routing and advances the step only while the same configuration and mounted step still own that operation.

## Tray startup

- Start minimized and launch at login load the ControlPanel renderer in a hidden window.
- The renderer hydrates settings and resolves persisted onboarding before meeting input is allowed. A fresh profile stays gated.
- Window restore and the load backstop do not show a tray-started panel. An explicit tray or navigation action shows it.
- A failed hidden load leaves the gate closed and permits tray startup to finish. An explicit open retries that load.
- Tray New Note, event and Settings commands wait in preload until ControlPanel subscribes. New Note and event actions also wait for loaded folders and tree readiness. Thus the initial Note selection cannot discard an event draft.
- The document-load sender guard applies to all three commands. Delivery of a command does not change window visibility.

## Home

- Home is the default main view. Notes without a selected note also shows Home.
- Recent Notes fetches up to 50 notes from all folders, selected by last update. The display groups and orders this set by creation time.
- Confirmed note events refresh the recent list. This includes deletion from a folder that is not loaded.
- Home updates its recent-note state and remount cache only from the current request. A superseded response cannot restore deleted rows on remount.
- Coming Up reads events through midnight seven days ahead and filters for other attendees. It shows at most five days with events. Today is always present.
- An event draft is saved on the first title or text edit, Record or Ask. Clicking an event row does not start recording.
- Join & transcribe / Take notes opens the meeting link when present and starts the calendar meeting flow.

## Settings selection

- Groups: General (Profile, Preferences, Notes), Meetings (Recording, Calendar), AI (Models, Providers, On-device, Dictionary), System (Privacy & Data, Advanced).
- A first untargeted opening selects Preferences. A later opening can keep the selected section.
- Privacy & Data controls audio retention and removal of all audio. It is not a general erase-all-data screen.
- The Advanced install button is available only when the CLI is not installed.

## Code locations

- `src/AppRouter.tsx`, `src/components/OnboardingFlow.tsx`, `src/components/onboarding/` — gate and steps.
- `src/helpers/tray.ts` — tray menu and title.
- `src/components/home/` — Home, Recent Notes, Coming Up.
- `src/components/notes/EventNoteDraft.tsx` — event draft persistence.
- `src/hooks/useUpcomingEvents.ts` — calendar window.
- `src/components/SettingsModal.tsx`, `src/components/SettingsPage.tsx` — Settings groups and sections.
