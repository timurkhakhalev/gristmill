# Calendars

This document contains the connection, sync and reminder rules of calendar integrations.
User paths: [Connect calendars](../product/user-journeys/calendars.md).

## Providers

- Google and Microsoft use direct OAuth and allow multiple accounts. They read calendars. The UI does not create or edit events.
- Connect is unavailable when the application has no OAuth registration for the provider. The Calendar UI has no fields for those registration credentials.
- For Google and Microsoft, only the primary calendar is enabled by default. The UI has a primary-only toggle, not an individual-calendar picker.
- Apple uses EventKit on macOS and reads Calendar.app accounts. Permission denial and a missing native helper are different errors. Disconnect stops the helper and the cache. It does not revoke the macOS permission.
- Settings requests system audio permission before connection and can stop on refusal. Onboarding continues calendar setup after refusal.

## Google account associations

- Google keeps a separate association for each account and calendar ID. Primary status, selection and sync tokens belong to that association.
- Live events stay eligible while any association is selected. Event sync chooses one selected account for each calendar.
- Disconnect removes only the associations of that account. It keeps historical event and Note links.

## Sync lifecycle

- Google and Microsoft normally refresh every two minutes, with error backoff.
- Stop invalidates in-flight interval and focus outcomes. A late completion cannot re-arm polling. A new explicit sync keeps its normal backoff policy.
- Disconnect invalidates pending token refresh, calendar-list and event-sync results. Reconnecting the same email creates a new connection identity. Old results cannot change it.
- Each Google or Microsoft account removal reconciles the cached active meeting with live calendar rows and reschedules reminders. Removing one account keeps delivered-reminder deduplication for the remaining accounts.
- Apple follows EventKit changes and periodic snapshots. Apple Calendar accepts data and permission messages only from its current helper process. Late stdout from a stopped or replaced helper cannot restore a disconnected calendar or change a replacement connection.

## Reminders

- Reminders are scheduled one minute before events with attendees or a meeting link.
- They depend on notification settings. They show a recording prompt. They do not start a recording.
- An active meeting suppresses prompts. Recording or cooldown can queue them.

## Participants

- Calendar notes store event participants. Known local names can enrich them.
- Participants are identity hints, not proof of speaker identity. See [speaker evidence](speaker-evidence.md).

## Code locations

- `src/components/IntegrationsView.tsx` — calendar controls.
- `src/components/onboarding/CalendarConnectionsStep.tsx` — onboarding permission behavior.
- `src/helpers/googleCalendarOAuth.ts`, `src/helpers/microsoftCalendarOAuth.ts` — availability and OAuth.
- `src/helpers/appleCalendarManager.ts` — EventKit lifecycle.
- `src/helpers/calendarReminderScheduler.ts` — reminder eligibility.
- `src/helpers/meetingDetectionEngine.ts` — prompt lifecycle and calendar notes.
