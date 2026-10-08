# Choose processing routes

As a Gristmill user, I want to select a model for each task that Gristmill does.

## Entry points

- **Gristmill app → Settings → Models → Tasks** — select a model for each task.
- **Gristmill app → Settings → Providers** — add API keys and set up bb harnesses.
- **Gristmill app → Settings → On-device** — download models that run on this Mac.

## Paths

Settings → Models has four tasks:

| Task              | What it does                              | Model sources                     |
| ----------------- | ----------------------------------------- | --------------------------------- |
| Meeting recording | Transcribes a recording after you stop it | Cloud, On-device                  |
| Audio upload      | Transcribes audio files that you upload   | Cloud, On-device                  |
| Meeting summary   | Writes the Summary from the transcript    | Cloud, On-device, Self-hosted, bb |
| Chat              | Answers questions about your notes        | Cloud, On-device, Self-hosted, bb |

### Use a cloud provider

1. Open Settings → Models and select a task.
2. On the **Cloud** tab, select a provider and a model. Each task shows only the providers that can do it. For example, Meeting recording offers only the providers that can transcribe a full meeting file with speakers.
3. If the task shows **Add an API key**, click **Add key** in the picker, or add the key in Settings → Providers. One key works for all tasks.
4. Record a meeting or upload a file. Gristmill uses the selected model.

### Use a model on this Mac

1. Open Settings → On-device and download a speech or language model.
2. Open Settings → Models, select the task and the **On-device** tab.
3. Click **Use this** on the downloaded model. A download alone does not change the model of a task.
4. Audio and text stay on your computer.

### Use a self-hosted server or a custom endpoint

1. For Meeting summary or Chat, select the **Self-hosted** tab and add the server URL.
2. For Audio upload, Meeting summary or Chat, select **Custom endpoint** on the **Cloud** tab to use any OpenAI-compatible API. For Meeting summary and Chat, you can also select OpenRouter.
3. Meeting recording does not offer a custom or self-hosted route.

### Use a bb harness for Summaries and chat

1. Open Settings → Providers → **Coding agents (bb)**. Enable the harnesses and select the default harness.
2. Open Settings → Models, select Meeting summary or Chat and the **bb** tab.
3. Keep **Default harness**, or select a harness and a model. See [BB integration](../../architecture/bb-integration.md).

### Fix a missing setting

1. If a recording waits for settings, the note shows **Transcription is waiting for settings** or **Summary is waiting for settings**.
2. Click **Open settings**, select a model or add a key, then retry. See [Recording results](meeting-results.md).
3. Gristmill never changes to another provider without your action. The saved audio stays.

### Upload a large file

1. Before an upload, Gristmill checks the file size against the limit of the selected provider.
2. If the file is too large, Gristmill shows the limit. Select a provider with a larger limit or a model on this Mac.

## BDD acceptance criteria

- Given I select Meeting recording, when the cloud picker opens, then it shows only providers that can transcribe a meeting file.
- Given I download a local model, when the download completes, then each task keeps its selected model.
- Given a provider fails, when I look at the note, then the saved meeting audio stays for a retry.

## Related documents

- [Processing routes](../../architecture/processing-routes.md) — provider lists, size limits and route rules.
- [Post-Stop processing](../../architecture/post-stop-processing.md) — provider limits for meetings.
