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
  noteConversations: ConversationRow[];
  activeConversationId: number | null;
  switchConversation: (id: number) => Promise<void>;
  startNewChat: () => void;
}

export function useEmbeddedChat({
  noteId,
  disabled = false,
  folderId,
  noteTitle,
  noteContent,
  noteTranscript,
}: UseEmbeddedChatOptions): UseEmbeddedChatReturn {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [noteConversations, setNoteConversations] = useState<ConversationRow[]>([]);
  const noteIdRef = useRef(noteId);
  const [prevNoteId, setPrevNoteId] = useState(noteId);

  const persistence = useChatPersistence({
    conversationId,
    onConversationCreated: (id) => {
      setConversationId(id);
    },
  });

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

  const streaming = useChatStreaming({
    disabled,
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    noteContext,
    noteId: noteId ?? undefined,
    onStreamComplete: (_id, content, toolCalls) => {
      persistence.saveAssistantMessage(content, toolCalls);
    },
  });

  const fetchNoteConversations = useCallback(async () => {
    if (!noteId) return;
    const conversations = await window.electronAPI?.getConversationsForNote?.(noteId);
    if (noteIdRef.current !== noteId) return;
    setNoteConversations(conversations ?? []);
    return conversations ?? [];
  }, [noteId]);

  if (noteId !== prevNoteId) {
    setPrevNoteId(noteId);
    if (!noteId) {
      persistence.handleNewChat();
      setConversationId(null);
      setNoteConversations([]);
    }
  }

  useEffect(() => {
    noteIdRef.current = noteId;
    if (!noteId) return;

    let stale = false;
    (async () => {
      const conversations = await window.electronAPI?.getConversationsForNote?.(noteId);
      if (stale || noteIdRef.current !== noteId) return;
      setNoteConversations(conversations ?? []);
      if (conversations?.length) {
        const mostRecent = conversations[0];
        await persistence.loadConversation(mostRecent.id);
        if (stale || noteIdRef.current !== noteId) return;
        setConversationId(mostRecent.id);
      } else {
        persistence.handleNewChat();
        setConversationId(null);
      }
    })();

    return () => {
      stale = true;
    };
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchConversation = useCallback(
    async (id: number) => {
      await persistence.loadConversation(id);
      setConversationId(id);
    },
    [persistence]
  );

  const startNewChat = useCallback(() => {
    persistence.handleNewChat();
    setConversationId(null);
  }, [persistence]);

  const createConversation = useCallback(
    async (text: string) => {
      const id = await persistence.createConversation(`Note: ${noteTitle || "Untitled"}`, noteId);
      void fetchNoteConversations();
      return id;
    },
    [fetchNoteConversations, noteId, noteTitle, persistence]
  );
  const sendMessageWithResult = useChatMessageSender({
    conversationId,
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
    noteConversations,
    activeConversationId: conversationId,
    switchConversation,
    startNewChat,
  };
}
