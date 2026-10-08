# Chat

This document contains the context, history, tool and save rules of the AI chat.
User paths: [AI conversations](../product/user-journeys/chat.md).
The BB route and the renderer conversation identity are in [BB integration](bb-integration.md).

## Entry points and context

- There are two AI entry points: Home chat and Note chat. `MeetingTranscriptChat` is a transcript display, not an AI conversation.
- Home starts with an empty chat on each mount. Its initial context contains the recent-note count and excerpts from up to 12 notes, at most 600 characters each. It does not send all notes automatically.
- Note context supplies title, folder ID, manual content and transcript. Summary and participants are not separate automatic context fields. Note tools can read saved Summary content.
- A BB Note turn receives the current Note ID instead of the full renderer note context.

## History

- Home history lists up to 50 non-archived conversations, including Note conversations. Opening history in Home keeps the Home context.
- Note history contains up to 20 conversations for that note and loads the most recently updated one.
- Note chat supports floating and sidebar layouts. Home uses a floating panel.
- Normal turns use at most the last 20 messages.

## Tools

- Both chats can search other local notes. Folder context does not restrict search to that folder.
- Tools depend on the model and the route. Renderer tools include note search, read, create and edit, folders, clipboard, Dictionary and Snippets. Calendar tools require a connected calendar. There is no web search.
- BB uses its own tool route. See [BB integration](bb-integration.md).
- Follow-up uses an action turn without tools or prior conversation history. It sends no external message.

## Save and cancellation rules

- Switching a conversation or starting New Chat cancels the active turn and rejects late history results. Replies never move into the newly opened conversation.
- AI starts only after the user message is saved. A failed save leaves the text visible with a retry action.
- If the first conversation creation failed, Retry creates it with the original scope and saves the retained message. Retry itself does not start another AI turn.
- A failed assistant save keeps the generated answer. Retry saves it without another AI request.
- A failed save must be resolved before the next message.
- Stop does not persist a partial assistant reply. Leaving the mounted chat can save the visible partial reply to its original conversation.

## Code locations

- `src/hooks/useHomeChat.ts` — Home context and history.
- `src/hooks/useEmbeddedChat.ts` — Note context and action turns.
- `src/components/chat/useChatStreaming.ts` — route and history limits.
- `src/components/chat/useChatPersistence.ts` — conversation identity and save rules.
- `src/services/tools/index.ts` — renderer tools.
