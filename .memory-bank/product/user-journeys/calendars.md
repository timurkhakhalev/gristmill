# Connect calendars

As a Gristmill user, I want to see my meetings in Gristmill and get a prompt to record them.

## Entry points

- **Gristmill app → Settings → Calendar** — connect and disconnect calendars.
- **Gristmill app → first launch → calendar step** — optional connection during setup.
- **Gristmill app → Home → Coming up → Connect Calendar** — opens Settings → Calendar.
- **Gristmill meeting notification** — the reminder before a meeting.

## Paths

### Connect Google Calendar or Microsoft Calendar

1. Open Settings → Calendar.
2. If Gristmill asks for System Audio permission, allow it. Without it, Settings cannot connect the calendar.
3. Click **Connect Google Calendar** or **Connect Microsoft Calendar**. The browser opens the account sign-in.
4. Sign in and allow access. The account appears as **Connected**.
5. To add another account, click **Add another calendar**.
6. If the provider shows **Set up OAuth to connect**, this build cannot connect it.

### Connect Apple Calendar

1. Open Settings → Calendar and click **Connect Apple Calendar**.
2. Allow calendar access in the macOS prompt. Gristmill reads the accounts of Calendar.app.
3. If you refused access, Gristmill shows **Calendar Access Required**. Click **Open System Settings** and allow access.

### Select which calendars to read

1. For a Google or Microsoft account, use **Sync primary calendar only**. It is on by default.
2. Turn it off to also read calendars that are shared with you.

### See meetings and get a reminder

1. Open Home. **Coming up** shows the events of the connected calendars. See [Home and navigation](home.md).
2. One minute before an event with other people or with a meeting link, Gristmill shows a notification with the event title and **Your meeting is starting. Want to take notes?** Notifications must be on.
3. Click **Join & transcribe** for an event with a meeting link, or **Take notes** for other events. Gristmill does not start a recording without your action.
4. During another meeting, Gristmill does not show the reminder.

### Use participants in a meeting note

1. Open the note of a calendar event. It shows the event participants.
2. Use the participants to name speakers. See [Correct speakers](speakers.md).

### Disconnect a calendar

1. Open Settings → Calendar and click **Disconnect** on the account.
2. Confirm. Gristmill stops reading events from that account. The notes of past events stay.
3. For Apple Calendar, macOS keeps the permission. Remove it in System Settings if necessary.

## BDD acceptance criteria

- Given OAuth is not set up for a provider, when I open Settings → Calendar, then I cannot connect that provider.
- Given a qualifying event approaches and notifications are on, when the reminder is due, then Gristmill offers to record and does not start a recording.
- Given I disconnect Apple Calendar, when the disconnection completes, then the macOS permission stays.

## Related documents

- [Calendar architecture](../../architecture/calendars.md) — sync, reminders and connection lifecycle.
