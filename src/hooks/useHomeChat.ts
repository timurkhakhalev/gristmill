import { useState, useCallback, useEffect, useMemo } from "react";
import { useChatPersistence } from "../components/chat/useChatPersistence";
import { useChatStreaming } from "../components/chat/useChatStreaming";
import { useChatMessageSender } from "../components/chat/useChatMessageSender";
import type { Message, AgentState } from "../components/chat/types";
import { deriveConversationTitle } from "../lib/conversationTitle";
import type { NoteItem } from "../contracts/notes";
import type { ConversationRow } from "../contracts/chatPersistence";

const MAX_CONTEXT_NOTES = 12;
const NOTE_SNIPPET_LENGTH = 600;

interface UseHomeChatReturn {
  messages: Message[];
  agentState: AgentState;
  sendMessage: (text: string) => Promise<void>;
  cancelStream: () => void;
  retrySaveMessage: (id: string) => Promise<void>;
  conversations: ConversationRow[];
  activeConversationId: number | null;
  switchConversation: (id: number) => Promise<void>;
  startNewChat: () => void;
}

/**
 * Home's chat: unscoped, searches every note, primed with the recent notes
 * Home lists. Each Home mount starts fresh; history lists every conversation.
 */
export function useHomeChat(notes: NoteItem[]): UseHomeChatReturn {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);

  const persistence = useChatPersistence();
  const conversationId = persistence.conversationId;

  const noteContext = useMemo(() => {
    const header = `The user is on the Home screen, which lists their ${notes.length} most recent notes across all spaces.`;
    const noteBlocks = notes.slice(0, MAX_CONTEXT_NOTES).map((note) => {
      const body = (note.enhanced_content || note.content || "").slice(0, NOTE_SNIPPET_LENGTH);
      return `<note id="${note.id}" title="${note.title}" updated="${note.updated_at}">\n${body}\n</note>`;
    });
    return [header, ...noteBlocks].join("\n\n");
  }, [notes]);

  const streaming = useChatStreaming({
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    noteContext,
  });

  const fetchConversations = useCallback(async (isStale?: () => boolean) => {
    let list: ConversationRow[];
    try {
      list = (await window.electronAPI?.getAgentConversations?.()) ?? [];
    } catch {
      list = [];
    }
    if (!isStale?.()) setConversations(list);
  }, []);

  useEffect(() => {
    let stale = false;
    void fetchConversations(() => stale);
    return () => {
      stale = true;
    };
  }, [fetchConversations]);

  const switchConversation = useCallback(
    async (id: number) => {
      streaming.cancelStream();
      await persistence.loadConversation(id);
    },
    [persistence, streaming]
  );

  const startNewChat = useCallback(() => {
    streaming.cancelStream();
    persistence.handleNewChat();
  }, [persistence, streaming]);

  const createConversation = useCallback(
    async (text: string) => {
      const id = await persistence.createConversation(deriveConversationTitle(text, ""), null);
      void fetchConversations();
      return id;
    },
    [fetchConversations, persistence]
  );
  const sendMessageWithResult = useChatMessageSender({
    persistence,
    streaming,
    createConversation,
  });
  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      await sendMessageWithResult(text);
    },
    [sendMessageWithResult]
  );

  return {
    messages: persistence.messages,
    agentState: streaming.agentState,
    sendMessage,
    cancelStream: streaming.cancelStream,
    retrySaveMessage: persistence.retrySaveMessage,
    conversations,
    activeConversationId: conversationId,
    switchConversation,
    startNewChat,
  };
}
