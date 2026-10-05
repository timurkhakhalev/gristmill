import { useState, useRef, useCallback, useEffect } from "react";
import type { Message, ToolCallInfo } from "./types";
import type { ContainerScope } from "../../types/chat";

export interface ChatSession {
  generation: number;
  conversationId: number | null;
}

export interface ChatPersistence {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: number | null;
  getSession: () => ChatSession;
  isCurrent: (session: ChatSession) => boolean;
  createConversation: (
    title: string,
    noteId?: number | null,
    scope?: ContainerScope
  ) => Promise<number | null>;
  loadConversation: (id: number) => Promise<void>;
  saveUserMessage: (session: ChatSession, message: Message) => Promise<boolean>;
  saveAssistantMessage: (
    session: ChatSession,
    id: string,
    content: string,
    toolCalls?: ToolCallInfo[]
  ) => Promise<boolean>;
  retrySaveMessage: (id: string) => Promise<void>;
  handleNewChat: () => void;
}

/** One owner for the visible conversation and the identity of pending work. */
export function useChatPersistence({ noteId }: { noteId?: number | null } = {}): ChatPersistence {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationIdRef = useRef<number | null>(null);
  const generation = useRef(0);
  const pendingCreation = useRef<{ title: string; noteId?: number | null; scope?: ContainerScope } | null>(null);
  const mounted = useRef(true);
  const [previousNoteId, setPreviousNoteId] = useState(noteId);
  const saving = useRef(new Set<string>());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const getSession = useCallback(
    (): ChatSession => ({
      generation: generation.current,
      conversationId: conversationIdRef.current,
    }),
    []
  );
  const isCurrent = useCallback(
    (session: ChatSession) =>
      session.generation === generation.current &&
      session.conversationId === conversationIdRef.current,
    []
  );
  const handleNewChat = useCallback(() => {
    generation.current++;
    pendingCreation.current = null;
    conversationIdRef.current = null;
    setConversationId(null);
    setMessages([]);
  }, []);

  // Invalidate before effects: callbacks from the old Note cannot publish into
  // the new Note during the interval before its history request starts.
  if (noteId !== previousNoteId) {
    setPreviousNoteId(noteId);
    handleNewChat();
  }

  const createConversation = useCallback(
    async (title: string, scopeNoteId?: number | null, scope?: ContainerScope) => {
      const session = getSession();
      pendingCreation.current = { title, noteId: scopeNoteId, scope };
      const conv = await window.electronAPI.createAgentConversation(
        title,
        scopeNoteId ?? undefined,
        scope?.spaceId,
        scope?.folderId ?? undefined
      );
      if (!mounted.current || !isCurrent(session)) return null;
      if (!conv) throw new Error("Conversation scope is no longer available");
      pendingCreation.current = null;
      conversationIdRef.current = conv.id;
      setConversationId(conv.id);
      return conv.id;
    },
    [getSession, isCurrent]
  );

  const loadConversation = useCallback(
    async (id: number) => {
      handleNewChat();
      const session = getSession();
      const conv = await window.electronAPI.getAgentConversation(id);
      if (!mounted.current || !isCurrent(session)) return;
      if (!conv) return;
      if (conv.id !== id || (noteId != null && conv.note_id !== noteId))
        throw new Error("Unexpected conversation identity");
      const loaded: Message[] = conv.messages.map((m) => {
        const parsed = m.metadata ? tryParseMetadata(m.metadata) : undefined;
        const toolCalls = parsed?.toolCalls as ToolCallInfo[] | undefined;
        return {
          id: crypto.randomUUID(),
          role: m.role as Message["role"],
          content: m.content,
          isStreaming: false,
          ...(toolCalls ? { toolCalls } : {}),
        };
      });
      conversationIdRef.current = id;
      setConversationId(id);
      setMessages(loaded);
    },
    [getSession, handleNewChat, isCurrent, noteId]
  );

  const saveMessage = useCallback(
    async (session: ChatSession, message: Message): Promise<boolean> => {
      if (!isCurrent(session) || session.conversationId === null || saving.current.has(message.id))
        return false;
      saving.current.add(message.id);
      const update = (changes: Partial<Message>) => {
        if (mounted.current && isCurrent(session))
          setMessages((messages) =>
            messages.map((m) => (m.id === message.id ? { ...m, ...changes } : m))
          );
      };
      update({ isSaving: true });
      try {
        const saved = await window.electronAPI.addAgentMessage(
          session.conversationId,
          message.role === "user" ? "user" : "assistant",
          message.content,
          message.toolCalls?.length ? { toolCalls: message.toolCalls } : undefined
        );
        if (!saved || saved.conversation_id !== session.conversationId)
          throw new Error("Message was not saved");
        update({ persistenceError: undefined });
        return true;
      } catch (error) {
        update({ persistenceError: error instanceof Error ? error.message : String(error) });
        return false;
      } finally {
        saving.current.delete(message.id);
        update({ isSaving: false });
      }
    },
    [isCurrent]
  );
  const saveUserMessage = useCallback(
    (session: ChatSession, message: Message) => saveMessage(session, message),
    [saveMessage]
  );
  const saveAssistantMessage = useCallback(
    (session: ChatSession, id: string, content: string, toolCalls?: ToolCallInfo[]) =>
      saveMessage(session, { id, role: "assistant", content, isStreaming: false, toolCalls }),
    [saveMessage]
  );
  const retrySaveMessage = useCallback(
    async (id: string) => {
      const message = messagesRef.current.find((m) => m.id === id && m.persistenceError);
      if (!message || saving.current.has(id)) return;
      const session = getSession();
      if (session.conversationId !== null) {
        await saveMessage(session, message);
        return;
      }
      const pending = pendingCreation.current;
      if (!pending || message.role !== "user") return;
      saving.current.add(id);
      setMessages(messages => messages.map(m => m.id === id ? { ...m, isSaving: true } : m));
      try {
        const conversationId = await createConversation(pending.title, pending.noteId, pending.scope);
        if (conversationId === null) return;
        saving.current.delete(id);
        await saveMessage({ ...session, conversationId }, message);
      } catch (error) {
        if (mounted.current && isCurrent(session)) setMessages(messages => messages.map(m =>
          m.id === id ? { ...m, persistenceError: error instanceof Error ? error.message : String(error) } : m));
      } finally {
        saving.current.delete(id);
        if (mounted.current && generation.current === session.generation) setMessages(messages =>
          messages.map(m => m.id === id ? { ...m, isSaving: false } : m));
      }
    },
    [createConversation, getSession, isCurrent, saveMessage]
  );

  return {
    messages,
    setMessages,
    conversationId,
    getSession,
    isCurrent,
    createConversation,
    loadConversation,
    saveUserMessage,
    saveAssistantMessage,
    retrySaveMessage,
    handleNewChat,
  };
}

function tryParseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
