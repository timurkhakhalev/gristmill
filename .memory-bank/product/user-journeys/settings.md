# Settings

As a Gristmill user, I want to configure the application, its recording and its AI tasks.

## Entry points

- **Gristmill app → sidebar → Settings** — opens Settings on the last section, or on Preferences the first time.
- **macOS menu bar → Gristmill tray icon → Settings** — opens the same window.
- **Other screens → Open settings** — some errors and empty states open the related section directly.

## Paths

Settings has four groups:

| Group    | Sections                                 |
| -------- | ---------------------------------------- |
| General  | Profile, Preferences, Notes              |
| Meetings | Recording, Calendar                      |
| AI       | Models, Providers, On-device, Dictionary |
| System   | Privacy & Data, Advanced                 |

### Set your name and preferences

1. Open **Profile** and enter your name. Gristmill uses it for your voice in meeting transcripts.
2. Open **Preferences** and set the interface language, the theme, the color scheme, the date and time format, startup and notifications.

### Set up recording

1. Open **Recording**.
2. Set the meeting hotkey, the meeting companion and the Chrome Companion.
3. Select the microphone and check the microphone and system audio permissions.

### Configure notes

1. Open **Notes**.
2. Turn automatic note titles on or off.
3. Turn on **Store note files** to keep a Markdown copy of notes. See [Note files](note-files.md).

### Connect a calendar

1. Open **Calendar**. See [Connect calendars](calendars.md).

### Select AI models and providers

1. Open **Models** and select a model for each task: transcription, summaries and chat.
2. Open **Providers** to add API keys and to set up bb harnesses.
3. Open **On-device** to download models that run on this Mac. A download does not change the model that a task uses. Select the downloaded model in **Models**.
4. See [Choose processing routes](providers.md).

### Edit the vocabulary

1. Open **Dictionary**. See [Dictionary and Snippets](dictionary-snippets.md).

### Control saved audio

1. Open **Privacy & Data**.
2. Set **Meeting audio retention** in days. The default is seven days. 0 keeps audio until you delete it.
3. If you make the period shorter, confirm **Reduce retention**. Older recordings are deleted at the next cleanup.
4. To delete all audio, click **Delete all audio** and confirm. Notes, transcripts and Summaries stay. If a meeting records, Gristmill stops it safely and does not start a transcription.

### Diagnose problems and install the CLI

1. Open **Advanced**.
2. Turn on debug logging, or click **Open Logs Folder**.
3. Click **Install Gristmill CLI** if the CLI is not installed. See [Gristmill CLI](gristmill-cli.md).

## BDD acceptance criteria

- Given a task has a selected model, when I download another local model, then the task keeps its model.
- Given I make audio retention shorter, when I apply the change, then Gristmill asks me to confirm.
- Given I delete all audio, when the deletion completes, then my notes, transcripts and Summaries stay.

## Related documents

- [Application shell](../../architecture/app-shell.md) — section selection rules.
- [Recording and processing](../../architecture/recording-processing.md) — retention and deletion.
