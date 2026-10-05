# Connect calendars

As a Gristmill user, I want to see meetings and receive recording prompts.

## User journey

1. Open Settings → Calendar or the optional calendar onboarding step.
2. Connect a configured Google/Microsoft account, or enable Apple Calendar access.
3. Review connected accounts and the primary-calendar preference.
4. Open upcoming events from Home and respond to recording reminders.
5. Disconnect an account when it is no longer needed.

## Behavior and limits

- Google and Microsoft use direct OAuth and allow multiple accounts. They read calendars; this UI does not create or edit events.
- Connect is unavailable when the application lacks the provider OAuth registration. Calendar UI has no fields for those registration credentials.
- Only primary calendar is enabled by default for Google and Microsoft. The current UI does not offer an arbitrary individual-calendar picker.
- Apple uses EventKit on macOS and reads Calendar.app accounts. Permission denial and a missing native helper are different errors. Disconnect stops the helper/cache; it does not revoke macOS permission.
- Settings requests system audio permission before connection and can stop on refusal. Onboarding continues calendar setup after refusal.
- Reminders are scheduled one minute before events with attendees or a meeting link. They depend on notification settings and show a recording prompt, not automatic recording.
- An active meeting suppresses prompts; recording/cooldown can queue them.
- Calendar notes store event participants. Known local names can enrich them, but participants remain identity hints.
- Disconnect invalidates pending token refresh, calendar-list and event-sync results. Reconnecting the same email creates a new connection identity; old results cannot change it.
- Google/Microsoft normally refresh every two minutes with error backoff. Apple follows EventKit changes and periodic snapshots.

Apple Calendar accepts data and permission messages only from its current helper process. Late stdout from a stopped or replaced helper cannot restore a disconnected calendar or change a replacement connection.

## What to check

- Unconfigured OAuth providers show an unavailable state.
- Disconnecting Apple preserves the system permission.
- A reminder offers recording instead of starting it.

## BDD acceptance criteria

- Given OAuth registration is absent, when I open Calendar, then that provider cannot be connected.
- Given a qualifying event approaches and notifications are enabled, when its reminder is due, then a recording prompt can appear.

## Entry points

- [IntegrationsView.tsx](../../../src/components/IntegrationsView.tsx) — calendar controls.
- [CalendarConnectionsStep.tsx](../../../src/components/onboarding/CalendarConnectionsStep.tsx) — onboarding permission behavior.
- [googleCalendarOAuth.ts](../../../src/helpers/googleCalendarOAuth.ts) — Google availability and OAuth.
- [microsoftCalendarOAuth.ts](../../../src/helpers/microsoftCalendarOAuth.ts) — Microsoft availability and OAuth.
- [appleCalendarManager.ts](../../../src/helpers/appleCalendarManager.ts) — EventKit lifecycle.
- [calendarReminderScheduler.ts](../../../src/helpers/calendarReminderScheduler.ts) — reminder eligibility.
- [meetingDetectionEngine.ts](../../../src/helpers/meetingDetectionEngine.ts) — prompt lifecycle and calendar notes.
