# AI conversations

As a Gristmill user, I want to ask questions and work with saved notes.

## User journey

1. Ask a question from Home, or open a note and use its chat.
2. Read the reply and follow note references.
3. Use conversation history or start a new chat.
4. From a note with a ready transcript, use Follow-up to create an assistant draft in the same chat.

## Behavior and limits

- There are two AI entry points: Home chat and Note chat. MeetingTranscriptChat is a transcript display, not an AI conversation.
- Home starts with an empty chat on each mount. Its initial context contains the recent-note count and excerpts from up to 12 notes, at most 600 characters each. It does not send all notes automatically.
- Home history lists up to 50 non-archived conversations, including Note conversations. Opening history in Home keeps the Home context.
- Note context supplies title, folder ID, manual content and transcript. Summary and participants are not separate automatic context fields.
- Note history contains up to 20 conversations for that note and loads the most recently updated one. Note chat supports floating and sidebar layouts; Home uses a floating panel.
- Both chats can search other local notes. Folder context does not restrict search to that folder.
- Tools depend on the model and route. Renderer tools include note search/read/create/edit, folders, clipboard, Dictionary and Snippets; calendar tools require a connected calendar. There is no web search.
- BB uses its own tool route. A BB Note turn receives the current Note ID instead of the full renderer note context.
- Normal turns use at most the last 20 messages. Follow-up uses an action turn without tools or prior conversation history and sends no external message.

- Switching a conversation or starting New Chat cancels the active turn and rejects late history results. Replies never move into the newly opened conversation.
- AI starts only after the user message is saved. A failed save leaves the text visible with a retry action. If the first conversation creation failed, Retry creates it with the original scope and saves the retained message. Retry itself does not start another AI turn. Failed assistant saves retain the generated answer; retry saves it without another AI request. Resolve a failed save before sending the next message.
- Stop does not persist a partial assistant reply. Leaving the mounted chat can save the visible partial reply to its original conversation.

## What to check

- Home and Note history have different scopes.
- A question can find a note outside the recent list when the route supports tools.

## BDD acceptance criteria

- Given I open Note chat, when its history loads, then it contains conversations for that note.
- Given I run Follow-up on a ready transcript, when it completes, then the draft appears as an assistant message in Note chat.

## Entry points

- [useHomeChat.ts](../../../src/hooks/useHomeChat.ts) — Home context and history.
- [useEmbeddedChat.ts](../../../src/hooks/useEmbeddedChat.ts) — Note context and action turns.
- [useChatStreaming.ts](../../../src/components/chat/useChatStreaming.ts) — route and history limits.
- [index.ts](../../../src/services/tools/index.ts) — renderer tools.
- [NoteEditor.tsx](../../../src/components/notes/NoteEditor.tsx) — chat and Follow-up controls.
- [MeetingTranscriptChat.tsx](../../../src/components/notes/MeetingTranscriptChat.tsx) — transcript display.
