import { useCallback, useRef } from "react";
import type { ChatPersistence } from "./useChatPersistence";
import type { ChatSendOptions, ChatStreaming } from "./useChatStreaming";
import type { Message } from "./types";

interface PersistedMessageContext {
  conversationId: number;
  text: string;
  isFirstMessage: boolean;
}

interface UseChatMessageSenderOptions {
  persistence: ChatPersistence;
  streaming: Pick<ChatStreaming, "sendToAI">;
  createConversation: (text: string) => Promise<number | null>;
  onBeforeSend?: () => void;
  onMessagePersisted?: (context: PersistedMessageContext) => void | Promise<void>;
  onSendingChange?: (sending: boolean) => void;
}

export interface MessageSubmissionLock {
  run: (operation: () => Promise<void>) => Promise<boolean>;
}

export function createMessageSubmissionLock(): MessageSubmissionLock {
  let active = false;

  return {
    async run(operation: () => Promise<void>): Promise<boolean> {
      if (active) return false;
      active = true;
      try {
        await operation();
        return true;
      } finally {
        active = false;
      }
    },
  };
}

export function useChatMessageSender({
  persistence,
  streaming,
  createConversation,
  onBeforeSend,
  onMessagePersisted,
  onSendingChange,
}: UseChatMessageSenderOptions): (text: string, sendOptions?: ChatSendOptions) => Promise<boolean> {
  const submissionLockRef = useRef<{
    generation: number;
    lock: MessageSubmissionLock;
  } | null>(null);

  return useCallback(
    async (text: string, sendOptions?: ChatSendOptions) => {
      const generation = persistence.getSession().generation;
      if (submissionLockRef.current?.generation !== generation) {
        submissionLockRef.current = { generation, lock: createMessageSubmissionLock() };
      }
      return await submissionLockRef.current.lock.run(async () => {
        onSendingChange?.(true);
        try {
          onBeforeSend?.();
          const session = persistence.getSession();
          if (persistence.messages.some((message) => message.persistenceError || message.isSaving))
            return;
          const previousMessages = persistence.messages;
          const userMessage: Message = {
            id: crypto.randomUUID(),
            role: "user",
            content: text,
            isStreaming: false,
          };
          persistence.setMessages((messages) => [...messages, userMessage]);
          try {
            const convId = session.conversationId ?? (await createConversation(text));
            if (convId === null) return;
            const destination = { ...session, conversationId: convId };
            if (!persistence.isCurrent(destination)) return;
            if (
              !(await persistence.saveUserMessage(destination, userMessage)) ||
              !persistence.isCurrent(destination)
            )
              return;
            await onMessagePersisted?.({
              conversationId: convId,
              text,
              isFirstMessage: previousMessages.length === 0,
            });
            if (!persistence.isCurrent(destination)) return;
            await streaming.sendToAI(text, [...previousMessages, userMessage], {
              ...sendOptions,
              conversationId: convId,
              onComplete: async (id, content, toolCalls) => {
                await persistence.saveAssistantMessage(destination, id, content, toolCalls);
              },
            });
          } catch (error) {
            if (persistence.isCurrent(session))
              persistence.setMessages((messages) =>
                messages.map((message) =>
                  message.id === userMessage.id
                    ? {
                        ...message,
                        persistenceError: error instanceof Error ? error.message : String(error),
                      }
                    : message
                )
              );
          }
        } finally {
          onSendingChange?.(false);
        }
      });
    },
    [createConversation, onBeforeSend, onMessagePersisted, onSendingChange, persistence, streaming]
  );
}
