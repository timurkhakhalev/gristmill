# Home and navigation

As a Gristmill user, I want to find upcoming meetings and return to my notes.

## Entry points

- **Gristmill app → sidebar → Home** — the default main view.
- **Gristmill app → sidebar → Actions, Upload file, Settings, spaces tree** — the other main areas.
- **macOS menu bar → Gristmill tray icon** — New Note, upcoming events and Settings.

## Paths

### Look at the day

1. Open Gristmill. Home opens after setup.
2. Read **Coming up**. It shows Today and the next days with meetings, at most five days.
3. Read the recent notes below. They are grouped by day: Today, Yesterday and earlier dates.

### Prepare notes for an upcoming meeting

1. In **Coming up**, click an event row.
2. Gristmill opens the note of the event. If the event has no note, Gristmill opens an unsaved draft.
3. Type a title or text, start a recording or ask the chat. Gristmill saves the note at that moment.
4. If you close the draft without a change, Gristmill does not save a note.

### Join a meeting and record it

1. In **Coming up**, click **Join & transcribe** on an event with a meeting link, or **Take notes** on an event without a link.
2. Gristmill opens the meeting link, if there is one, and starts the meeting note flow.
3. Clicking the event row itself never starts a recording.

### Connect a calendar from Home

1. If no calendar is connected, **Coming up** shows **Connect your calendar**.
2. Click **Connect Calendar**. Settings → Calendar opens. See [Connect calendars](calendars.md).

### Return to a note

1. In the recent notes, click a note to open it.
2. To move a note, open its menu and click **Move to folder**.
3. To delete a note, open its menu and click **Delete**. The note goes out of the list.

### Use the tray

1. Look at the macOS menu bar. Next to the Gristmill icon, you see the next meeting and the time until it starts, or the time that is left.
2. Click the icon. The menu shows the current meeting, the next meeting (**Starts in …**) and a meeting tomorrow.
3. On the current meeting, click **Open note**, or click **Skip this meeting** to remove it from the menu.
4. Click **New Note** or **Settings**. Gristmill opens the window and goes to the selected item. If the window still loads, Gristmill does the action when the window is ready.
5. During a recording, the menu shows **Recording in progress** and **Stop recording**.

### Move between areas

1. Use the sidebar to open Home, Actions, Upload file or Settings.
2. Use the spaces tree in the sidebar to open a folder or a note.

## BDD acceptance criteria

- Given an event has no saved note, when I click its row, then I see an unsaved draft until I edit, record or ask.
- Given I click an event row, when the draft opens, then no recording starts.
- Given I delete a recent note, when the deletion is confirmed, then the note leaves Home.
- Given I click **New Note** in the tray while the window loads, when the window is ready, then the new note opens.

## Related documents

- [Application shell](../../architecture/app-shell.md) — Home data windows, refresh rules and tray command delivery.
- [Connect calendars](calendars.md) — calendar connection and reminders.
