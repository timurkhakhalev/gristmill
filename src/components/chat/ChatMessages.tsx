import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { ChatMessage } from "./ChatMessage";
import type { Message } from "./types";

interface ChatMessagesProps {
  messages: Message[];
  emptyState?: React.ReactNode;
  onOpenNote?: (noteId: number) => void;
  onRetrySave?: (id: string) => Promise<void>;
}

export function ChatMessages({ messages, emptyState, onOpenNote, onRetrySave }: ChatMessagesProps) {
  const { t } = useTranslation();

  // Follow the stream only while the user is at the bottom; scrolling up to
  // re-read must not be yanked back down by the next token.
  const {
    scrollRef,
    handleScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useStickToBottom<HTMLDivElement>(messages);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className={cn("flex-1 overflow-y-auto agent-chat-scroll", "px-3 py-2")}
    >
      {messages.length === 0 ? (
        (emptyState ?? null)
      ) : (
        <div className="flex flex-col gap-3">
          {messages
            .filter((msg) => msg.role !== "tool")
            .map((msg) => (
              <div key={msg.id}>
                <ChatMessage
                  role={msg.role as "user" | "assistant"}
                  content={msg.content}
                  isStreaming={msg.isStreaming}
                  toolCalls={msg.toolCalls}
                  onOpenNote={onOpenNote}
                />
                {msg.persistenceError && (
                  <div role="alert" className="mt-1 text-xs text-danger">
                    <p>{t("agentMode.chat.saveFailed")}</p>
                    {onRetrySave && (
                      <button
                        type="button"
                        disabled={msg.isSaving}
                        onClick={() => void onRetrySave(msg.id)}
                        className="mt-1 underline disabled:opacity-50"
                      >
                        {t("agentMode.chat.retrySave")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
