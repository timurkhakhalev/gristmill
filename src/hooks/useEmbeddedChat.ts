import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useChatPersistence } from "../components/chat/useChatPersistence";
import { useChatStreaming, type ChatSendOptions } from "../components/chat/useChatStreaming";
import { useChatMessageSender } from "../components/chat/useChatMessageSender";
import type { Message, AgentState } from "../components/chat/types";
import type { ConversationRow } from "../contracts/chatPersistence";

interface UseEmbeddedChatOptions {
  noteId: number | null;
  disabled?: boolean;
  folderId: number | null;
  noteTitle: string;
  noteContent: string;
  noteTranscript?: string;
}

interface UseEmbeddedChatReturn {
  messages: Message[];
  agentState: AgentState;
  sendMessage: (text: string) => Promise<void>;
  sendActionMessage: (text: string, systemPrompt: string) => Promise<void>;
  cancelStream: () => void;
  retrySaveMessage: (id: string) => Promise<void>;
  noteConversations: ConversationRow[];
  activeConversationId: number | null;
  switchConversation: (id: number) => Promise<void>;
  startNewChat: () => void;
}

const CONVERSATION_TITLE_MAX = 40;

function conversationTitleFromMessage(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CONVERSATION_TITLE_MAX
    ? `${flat.slice(0, CONVERSATION_TITLE_MAX).trimEnd()}…`
    : flat || "Untitled";
}

export function useEmbeddedChat({
  noteId,
  disabled = false,
  folderId,
  noteTitle,
  noteContent,
  noteTranscript,
}: UseEmbeddedChatOptions): UseEmbeddedChatReturn {
  const [noteConversations, setNoteConversations] = useState<ConversationRow[]>([]);
  const persistence = useChatPersistence({ noteId });
  const conversationId = persistence.conversationId;

  const noteContext = useMemo(
    () =>
      [
        `Note ID: ${noteId}`,
        folderId != null ? `Folder ID: ${folderId}` : "",
        `Title: ${noteTitle}`,
        `Content:\n${noteContent}`,
        noteTranscript ? `\nTranscript:\n${noteTranscript}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    [folderId, noteContent, noteId, noteTitle, noteTranscript]
  );

  // A conversation keeps the first message's opening as its title until bb names the thread.
  const untitledConversationRef = useRef<number | null>(null);
  const fetchConversationsRef = useRef<() => Promise<unknown>>(async () => {});

  const streaming = useChatStreaming({
    disabled,
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    noteContext,
    noteId: noteId ?? undefined,
    onThreadTitle: (title, id) => {
      if (untitledConversationRef.current !== id || persistence.getSession().conversationId !== id)
        return;
      untitledConversationRef.current = null;
      void window.electronAPI
        ?.updateAgentConversationTitle?.(id, title)
        .then(() => fetchConversationsRef.current());
    },
  });

  const fetchNoteConversations = useCallback(async () => {
    if (!noteId) return;
    const session = persistence.getSession();
    const conversations = await window.electronAPI.getConversationsForNote(noteId);
    if (!persistence.isCurrent(session)) return;
    setNoteConversations(conversations ?? []);
    return conversations ?? [];
  }, [noteId, persistence]);

  fetchConversationsRef.current = fetchNoteConversations;

  useEffect(() => {
    untitledConversationRef.current = null;
    setNoteConversations([]);
    if (!noteId) return;
    const session = persistence.getSession();
    let active = true;
    void (async () => {
      const conversations = await window.electronAPI.getConversationsForNote(noteId);
      if (!active || !persistence.isCurrent(session)) return;
      setNoteConversations(conversations);
      if (conversations.length) await persistence.loadConversation(conversations[0].id);
    })();
    return () => {
      active = false;
      streaming.cancelStream();
    };
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const { getSession, isCurrent } = persistence;
  useEffect(() => {
    if (!noteId || conversationId === null) return;
    const session = getSession();
    let stale = false;
    void window.electronAPI.getConversationsForNote(noteId).then(conversations => {
      if (!stale && isCurrent(session)) setNoteConversations(conversations ?? []);
    }).catch(() => {
      if (!stale && isCurrent(session)) setNoteConversations([]);
    });
    return () => { stale = true; };
  }, [noteId, conversationId, getSession, isCurrent]);

  const switchConversation = useCallback(
    async (id: number) => {
      streaming.cancelStream();
      untitledConversationRef.current = null;
      await persistence.loadConversation(id);
    },
    [persistence, streaming]
  );

  const startNewChat = useCallback(() => {
    streaming.cancelStream();
    untitledConversationRef.current = null;
    persistence.handleNewChat();
  }, [persistence, streaming]);

  const createConversation = useCallback(
    async (text: string) => {
      const id = await persistence.createConversation(conversationTitleFromMessage(text), noteId);
      untitledConversationRef.current = id;
      return id;
    },
    [noteId, persistence]
  );
  const sendMessageWithResult = useChatMessageSender({
    persistence,
    streaming,
    createConversation,
  });
  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      if (disabled) return;
      await sendMessageWithResult(text);
    },
    [disabled, sendMessageWithResult]
  );
  const sendActionMessage = useCallback(
    async (text: string, systemPrompt: string): Promise<void> => {
      if (disabled) return;
      const options: ChatSendOptions = {
        systemPrompt,
        disableTools: true,
        includeConversationHistory: false,
      };
      await sendMessageWithResult(text, options);
    },
    [disabled, sendMessageWithResult]
  );

  return {
    messages: persistence.messages,
    agentState: streaming.agentState,
    sendMessage,
    sendActionMessage,
    cancelStream: streaming.cancelStream,
    retrySaveMessage: persistence.retrySaveMessage,
    noteConversations,
    activeConversationId: conversationId,
    switchConversation,
    startNewChat,
  };
}
