import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { X, PanelRight, PanelRightClose, Sparkles } from "../icons";
import { IconTooltip } from "../ui/IconTooltip";
import { cn } from "../lib/utils";
import { ChatMessages } from "../chat/ChatMessages";
import { ChatInput } from "../chat/ChatInput";
import type { Message, AgentState } from "../chat/types";
import { setActiveNoteId, setActiveFolderId } from "../../stores/noteStore";
import type { ConversationRow } from "../../contracts/chatPersistence";
import { ConversationPicker } from "./ConversationPicker";
import { FLOATING_CHAT_MAX_HEIGHT_CSS } from "./floatingChatLayout";

export type EmbeddedChatMode = "hidden" | "floating" | "sidebar";

interface EmbeddedChatProps {
  mode: EmbeddedChatMode;
  onModeChange: (mode: EmbeddedChatMode) => void;
  messages: Message[];
  agentState: AgentState;
  onTextSubmit: (text: string) => void;
  onCancel: () => void;
  noteConversations?: ConversationRow[];
  activeConversationId?: number | null;
  onSwitchConversation?: (id: number) => void;
  onNewChat?: () => void;
  voiceDraft?: boolean;
  preview?: boolean;
  /** Floating panel ref; NoteEditor reserves scroll space with it. */
  floatingPanelRef?: React.Ref<HTMLDivElement>;
}

const SUGGESTIONS = ["summary", "actions", "decisions"] as const;

function EmptyState({ onAsk }: { onAsk: (text: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center select-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
      <span className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-primary">
        <Sparkles size={16} />
      </span>
      <p className="max-w-52 text-sm text-muted">{t("embeddedChat.emptyState")}</p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {SUGGESTIONS.map((key) => {
          const text = t(`embeddedChat.suggestions.${key}`);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onAsk(text)}
              className="rounded-full border border-border px-3 py-1 text-xs text-foreground transition-colors hover:border-border-hover hover:bg-default focus-visible:ring-2 focus-visible:ring-focus outline-none"
            >
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
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

export default function EmbeddedChat({
  mode,
  onModeChange,
  messages,
  agentState,
  onTextSubmit,
  onCancel,
  noteConversations,
  activeConversationId,
  onSwitchConversation,
  onNewChat,
  voiceDraft = true,
  preview = false,
  floatingPanelRef,
}: EmbeddedChatProps) {
  const { t } = useTranslation();

  const handleOpenNote = useCallback(async (noteId: number) => {
    const note = await window.electronAPI.getNote(noteId);
    if (note?.folder_id) setActiveFolderId(note.folder_id);
    setActiveNoteId(noteId);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && mode === "floating") {
        onModeChange("hidden");
      }
    },
    [mode, onModeChange]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (mode === "hidden") return null;

  const hasConversationSelector =
    noteConversations !== undefined && onSwitchConversation !== undefined;

  const headerTitle = hasConversationSelector ? (
    <ConversationPicker
      conversations={noteConversations}
      activeConversationId={activeConversationId}
      onSwitchConversation={onSwitchConversation}
      onNewChat={onNewChat}
      titleClassName="max-w-32"
    />
  ) : (
    <span className="text-sm font-medium text-foreground">{t("embeddedChat.title")}</span>
  );

  const header = (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center ps-3 pe-1.5",
        mode === "sidebar" && "border-b border-border"
      )}
    >
      {headerTitle}
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        {mode === "floating" ? (
          <HeaderButton label={t("embeddedChat.dock")} onPress={() => onModeChange("sidebar")}>
            <PanelRight size={15} className="rtl:scale-x-[-1]" />
          </HeaderButton>
        ) : (
          <HeaderButton label={t("embeddedChat.undock")} onPress={() => onModeChange("floating")}>
            <PanelRightClose size={15} className="rtl:scale-x-[-1]" />
          </HeaderButton>
        )}
        <HeaderButton label={t("embeddedChat.close")} onPress={() => onModeChange("hidden")}>
          <X size={15} />
        </HeaderButton>
      </div>
    </div>
  );

  const chatContent = (
    <>
      {header}
      <div className="flex-1 min-h-0 flex flex-col **:data-chat-bubble:max-w-full">
        <ChatMessages messages={messages} emptyState={<EmptyState onAsk={onTextSubmit} />} onOpenNote={preview ? undefined : handleOpenNote} />
      </div>
      <ChatInput
        agentState={agentState}
        partialTranscript=""
        onTextSubmit={onTextSubmit}
        onCancel={onCancel}
        voiceDraft={voiceDraft}
      />
    </>
  );

  if (mode === "floating") {
    return (
      <div
        ref={floatingPanelRef}
        style={{ maxHeight: FLOATING_CHAT_MAX_HEIGHT_CSS }}
        className={cn(
          "absolute bottom-4 left-5 right-5 z-20 mx-auto max-w-[600px]",
          "min-h-50",
          "flex flex-col",
          "bg-overlay/95 text-overlay-foreground",
          "border border-border",
          "rounded-xl",
          "shadow-overlay",
          "backdrop-blur-2xl",
          "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-200"
        )}
      >
        {chatContent}
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
      {chatContent}
    </div>
  );
}
