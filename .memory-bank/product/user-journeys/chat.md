# AI conversations

As a Gristmill user, I want to ask questions about my notes and meetings and work with the answers.

## Entry points

- **Gristmill app → Home → chat bar** — questions about all notes.
- **Gristmill app → open note → Chat** — questions about one note.
- **Chat composer → model picker** — select the API route or a bb harness for the chat.

## Paths

### Ask about all notes from Home

1. Open Home. The chat bar shows **Ask anything about your notes and meetings**.
2. Type a question and send it. Home starts a new chat each time you open it.
3. Read the answer. The chat knows your recent notes and can search the other notes.
4. Click a note reference in the answer to open that note.

### Ask about one note

1. Open a note and open its chat. The chat shows **Ask a question about this note**.
2. Select a suggestion, for example **Summarize this note** or **What are the action items?**, or type your own question.
3. Read the answer. The chat knows the title, your notes and the transcript of this note. It can also search other notes.
4. To keep the chat next to the note, click **Dock to sidebar**. To make it float again, click **Undock from sidebar**.

### Continue an earlier conversation

1. In the chat, open **Switch conversation**.
2. Select a conversation. In Home, you see recent conversations from Home and from notes. In a note, you see only the conversations of that note.
3. Continue the conversation. A note opens its most recent conversation automatically.

### Start a new conversation

1. Click **New chat**.
2. If an answer is still in progress, Gristmill stops it. The old answer never goes into the new conversation.

### Draft a follow-up after a meeting

1. Open a note with a ready transcript.
2. Click **Draft a follow-up**. Before the transcript is ready, the button is not available.
3. Read the draft in the note chat. Gristmill does not send any message.

### Let the chat change notes and vocabulary

1. Ask the chat to create or edit a note, to create a folder, or to update the Dictionary or Snippets.
2. The chat does the change with its tools and shows the tool activity.
3. If a calendar is connected, you can also ask about your calendar events.
4. The tools depend on the selected model. The chat has no web search.

### Select a model or a bb harness

1. Open the model picker in the composer.
2. Select the **API** tab to use the chat route from Settings → Models.
3. Or select a bb harness, a model and a reasoning level. The bb agent runs in the installed bb app with your provider subscription.

### Work with a bb agent

1. Select a bb harness in the composer picker.
2. Ask about the current meeting or about other meetings. The agent gets the ID of the current note and reads other notes with the [Gristmill CLI](gristmill-cli.md).
3. Ask the agent to create or edit a note, to create a folder, or to update the Dictionary or Snippets.
4. The agent cannot delete notes, delete audio or start a transcription.
5. To use a different harness, start a new chat. You can change the model and the reasoning level in the same chat.

### Stop or recover an answer

1. Click Stop to stop an answer. Gristmill does not save the part of the answer that you stopped.
2. If Gristmill cannot save your message or the answer, the text stays visible with a retry action.
3. Click retry. Gristmill saves the text again. It does not ask the AI again.
4. You cannot send the next message before the failed save is resolved.

## BDD acceptance criteria

- Given I open the chat of a note, when its history loads, then I see the conversations of that note.
- Given I click **Draft a follow-up** on a ready transcript, when it completes, then the draft appears as an assistant message in the note chat.
- Given an answer is in progress, when I click **New chat**, then the answer does not appear in the new conversation.
- Given my message did not save, when I click retry, then Gristmill saves it without a new AI request.
- Given I chat with a bb harness, when I ask the agent to delete a note, then the agent cannot do it.

## Related documents

- [Chat architecture](../../architecture/chat.md) — context, history limits, tools and save rules.
- [BB integration](../../architecture/bb-integration.md) — the bb chat route.
