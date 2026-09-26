import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { X, PanelRight, PanelRightClose, Sparkles, SquarePen } from "../icons";
import { IconTooltip } from "../ui/IconTooltip";
import { cn } from "../lib/utils";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import { ConversationPicker } from "./ConversationPicker";
import type { Message, AgentState } from "./types";
import type { ConversationRow } from "../../contracts/chatPersistence";
import { FLOATING_CHAT_MAX_HEIGHT_CSS } from "../notes/floatingChatLayout";

export type ChatPanelMode = "hidden" | "floating" | "sidebar";

interface ChatPanelProps {
  mode: ChatPanelMode;
  onModeChange: (mode: ChatPanelMode) => void;
  messages: Message[];
  agentState: AgentState;
  onTextSubmit: (text: string) => void;
  onCancel: () => void;
  conversations?: ConversationRow[];
  activeConversationId?: number | null;
  onSwitchConversation?: (id: number) => void;
  onNewChat?: () => void;
  /** One-tap prompts shown above the input. */
  suggestions?: string[];
  emptyStateText: string;
  onOpenNote?: (noteId: number) => void;
  /** Hosts that have room for a docked column offer the sidebar mode. */
  allowSidebar?: boolean;
  voiceDraft?: boolean;
  /** Floating panel ref; NoteEditor reserves scroll space with it. */
  floatingPanelRef?: React.Ref<HTMLDivElement>;
  /** Tallest the floating card may grow, relative to its positioned ancestor. */
  floatingMaxHeight?: string;
}

function HeaderButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <IconTooltip label={label}>
      <Button isIconOnly size="sm" variant="ghost" className="size-7 min-h-7 text-muted" aria-label={label} onPress={onPress}>
        {children}
      </Button>
    </IconTooltip>
  );
}

/**
 * The one chat surface for Home and notes: a floating card that rises from the
 * ask bar (history, new chat and close in its header, prompts above the input),
 * or a docked column where the host has room for it.
 */
export default function ChatPanel({
  mode,
  onModeChange,
  messages,
  agentState,
  onTextSubmit,
  onCancel,
  conversations,
  activeConversationId,
  onSwitchConversation,
  onNewChat,
  suggestions = [],
  emptyStateText,
  onOpenNote,
  allowSidebar = false,
  voiceDraft = true,
  floatingPanelRef,
  floatingMaxHeight = FLOATING_CHAT_MAX_HEIGHT_CSS,
}: ChatPanelProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (mode !== "floating") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onModeChange("hidden");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, onModeChange]);

  if (mode === "hidden") return null;

  const header = (
    <div
      className={cn(
        "flex h-11 shrink-0 items-center ps-4 pe-2",
        mode === "sidebar" && "border-b border-border"
      )}
    >
      {conversations && onSwitchConversation && (
        <ConversationPicker
          variant="history"
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSwitchConversation={onSwitchConversation}
          onNewChat={onNewChat}
        />
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        {onNewChat && (
          <HeaderButton label={t("embeddedChat.newChat")} onPress={onNewChat}>
            <SquarePen size={15} />
          </HeaderButton>
        )}
        {allowSidebar &&
          (mode === "floating" ? (
            <HeaderButton label={t("embeddedChat.dock")} onPress={() => onModeChange("sidebar")}>
              <PanelRight size={15} className="rtl:scale-x-[-1]" />
            </HeaderButton>
          ) : (
            <HeaderButton label={t("embeddedChat.undock")} onPress={() => onModeChange("floating")}>
              <PanelRightClose size={15} className="rtl:scale-x-[-1]" />
            </HeaderButton>
          ))}
        <HeaderButton label={t("embeddedChat.close")} onPress={() => onModeChange("hidden")}>
          <X size={15} />
        </HeaderButton>
      </div>
    </div>
  );

  const isIdle = agentState === "idle";
  const content = (
    <>
      {header}
      <div className="flex min-h-0 flex-1 flex-col **:data-chat-bubble:max-w-full">
        <ChatMessages
          messages={messages}
          onOpenNote={onOpenNote}
          emptyState={
            <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center select-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
              <span className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-primary">
                <Sparkles size={16} />
              </span>
              <p className="max-w-60 text-sm text-muted">{emptyStateText}</p>
            </div>
          }
        />
      </div>
      {suggestions.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-2 pb-1">
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onTextSubmit(text)}
              disabled={!isIdle}
              className="inline-flex items-center gap-1.5 rounded-md text-xs text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-50"
            >
              <Sparkles size={12} className="shrink-0" />
              {text}
            </button>
          ))}
        </div>
      )}
      <ChatInput
        agentState={agentState}
        partialTranscript=""
        onTextSubmit={onTextSubmit}
        onCancel={onCancel}
        voiceDraft={voiceDraft}
        placeholder={t("embeddedChat.askPlaceholder")}
        autoFocus
      />
    </>
  );

  if (mode === "floating") {
    return (
      <div
        ref={floatingPanelRef}
        style={{ height: `min(36rem, ${floatingMaxHeight})` }}
        className={cn(
          "absolute bottom-4 left-5 right-5 z-20 mx-auto max-w-[680px]",
          "flex flex-col",
          "bg-overlay/95 text-overlay-foreground",
          "border border-border",
          "rounded-3xl",
          "shadow-overlay",
          "backdrop-blur-2xl",
          "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"
        )}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "w-85 shrink-0 max-[850px]:absolute max-[850px]:inset-y-0 max-[850px]:end-0 max-[850px]:z-30 max-[850px]:w-[min(340px,calc(100%-48px))] max-[850px]:shadow-overlay",
        "border-s border-border",
        "bg-surface",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-4 motion-safe:duration-200",
        "flex flex-col",
        "min-h-0"
      )}
    >
      {content}
    </div>
  );
}
