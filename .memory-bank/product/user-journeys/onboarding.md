# First launch

As a Gristmill user, I want to set up recording and optional integrations before my first meeting.

## Entry points

- **Gristmill app → first launch** — the setup flow opens before the main window.
- **Gristmill app → tray or launch at login** — the app starts hidden. The setup flow opens when you open the window.

## Paths

### Complete the full setup

1. Open Gristmill for the first time. The **Set up Gristmill in 3 minutes** screen opens.
2. Click **Enable** for the microphone. You cannot continue without microphone access.
3. Optionally enable System Audio and Accessibility. Gristmill uses System Audio to record the other people on the call.
4. Click **Continue**. Enter your name in **What should we call you?** Gristmill uses this name for your voice in transcripts.
5. In **Connect your AI provider**, choose a transcription provider and a model, paste the API key and click **Proceed**. Gristmill checks and saves the key. If the save fails, click **Proceed** again.
6. In **Which languages do you speak?**, select your languages and click **Continue**.
7. In the calendar step, connect Google Calendar, Microsoft Outlook or Apple Calendar.
8. Click **Finish**. Home opens.

### Skip the optional steps

1. Grant microphone access and click **Continue**.
2. Click **Skip** on the name step.
3. Click **Configure a provider later** on the provider step.
4. Continue without languages and without a calendar.
5. Click **Finish**. Home opens. You can set up the provider, the languages and the calendar later in Settings.

### Connect a calendar without System Audio

1. Refuse the System Audio permission.
2. Go to the calendar step and connect a calendar. The setup flow lets you continue.

### Return to an incomplete setup

1. Quit Gristmill before you click **Finish**.
2. Open Gristmill again. The setup flow starts again from the first step.

## BDD acceptance criteria

- Given microphone access is missing, when I view the permissions screen, then I cannot continue.
- Given I skip the provider and the calendar, when I click **Finish**, then Home opens.
- Given I quit before **Finish**, when I open Gristmill again, then the setup flow starts again.

## Related documents

- [Application shell](../../architecture/app-shell.md) — setup gate, provider save and tray startup rules.
- [Processing routes](providers.md) — the transcription routes that you can select.
