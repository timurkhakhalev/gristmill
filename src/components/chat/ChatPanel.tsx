import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { X, PanelRight, PanelRightClose, Sparkles, SquarePen } from "../icons";
import { IconTooltip } from "../ui/IconTooltip";
import { cn } from "../lib/utils";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import ChatModelPicker from "./ChatModelPicker";
import { ConversationPicker } from "./ConversationPicker";
import type { Message, AgentState } from "./types";
import type { ConversationRow } from "../../contracts/chatPersistence";
import { FLOATING_CHAT_MAX_HEIGHT_CSS } from "../notes/floatingChatLayout";

const FLOATING_CLOSE_MS = 160;

const FLOATING_DEFAULT_HEIGHT_PX = 576;

const FLOATING_MIN_HEIGHT_PX = 240;

const FLOATING_HEIGHT_KEY = "gristmill.floatingChatHeight";

function readStoredHeight(): number | null {
  const value = Number(localStorage.getItem(FLOATING_HEIGHT_KEY));

  return Number.isFinite(value) && value >= FLOATING_MIN_HEIGHT_PX ? value : null;
}

// React.Ref is either a callback or a mutable object; only the callback is callable.
function isRefCallback(
  ref: React.Ref<HTMLDivElement> | undefined
): ref is React.RefCallback<HTMLDivElement> {
  return typeof ref === "function";
}

export type ChatPanelMode = "hidden" | "floating" | "sidebar";

interface ChatPanelProps {
  mode: ChatPanelMode;
  onModeChange: (mode: ChatPanelMode) => void;
  messages: Message[];
  agentState: AgentState;
  onTextSubmit: (text: string) => void;
  onCancel: () => void;
  onRetrySave?: (id: string) => Promise<void>;
  conversations?: ConversationRow[];
  activeConversationId?: number | null;
  onSwitchConversation?: (id: number) => void;
  onNewChat?: () => void;
  /** One-tap prompts shown above the input. */
  suggestions?: string[];
  emptyStateText: string;
  onOpenNote?: (noteId: number) => void;
  /** Runs the editable Follow-up action; its draft arrives as an ordinary assistant message. */
  followUp?: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    title?: string;
    error?: string;
  };
  /** Hosts that have room for a docked column offer the sidebar mode. */
  allowSidebar?: boolean;
  voiceDraft?: boolean;
  /** Floating panel ref; NoteEditor reserves scroll space with it. */
  floatingPanelRef?: React.Ref<HTMLDivElement>;
  /** Tallest the floating card may grow, relative to its positioned ancestor. */
  floatingMaxHeight?: string;
}

function HeaderButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <IconTooltip label={label}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        className="size-7 min-h-7 text-muted"
        aria-label={label}
        onPress={onPress}
      >
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
  mode: requestedMode,
  onModeChange,
  messages,
  agentState,
  onTextSubmit,
  onCancel,
  onRetrySave,
  conversations,
  activeConversationId,
  onSwitchConversation,
  onNewChat,
  suggestions = [],
  followUp,
  emptyStateText,
  onOpenNote,
  allowSidebar = false,
  voiceDraft = true,
  floatingPanelRef,
  floatingMaxHeight = FLOATING_CHAT_MAX_HEIGHT_CSS,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const mode = requestedMode;
  // The floating card stays mounted while it plays its exit animation.
  const [closing, setClosing] = useState(false);
  const [previousMode, setPreviousMode] = useState(mode);

  if (mode !== previousMode) {
    setPreviousMode(mode);
    setClosing(previousMode === "floating" && mode === "hidden");
  }

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setClosing(false), FLOATING_CLOSE_MS);

    return () => clearTimeout(timer);
  }, [closing]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(readStoredHeight);
  const resize = useRef<{ startY: number; startHeight: number; cap: number } | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;

    if (!panel) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startHeight = panel.getBoundingClientRect().height;
    // The host's max-height is a CSS expression, so measure the tallest the card can be.
    const inline = panel.style.height;
    panel.style.height = `min(100vh, ${floatingMaxHeight})`;
    const cap = panel.getBoundingClientRect().height;
    panel.style.height = inline;
    resize.current = { startY: e.clientY, startHeight, cap };
  };

  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = resize.current;
    const panel = panelRef.current;

    if (!start || !panel) return;
    // The card is bottom-anchored, so dragging its top edge up grows it, up to the host's cap.
    setHeight(
      Math.round(
        Math.min(
          start.cap,
          Math.max(FLOATING_MIN_HEIGHT_PX, start.startHeight + start.startY - e.clientY)
        )
      )
    );
  };

  const onResizeEnd = () => {
    if (!resize.current) return;
    resize.current = null;

    if (heightRef.current != null)
      localStorage.setItem(FLOATING_HEIGHT_KEY, String(heightRef.current));
  };

  // One node, two owners: the click-outside check here and the host's layout observer.
  const setPanelRef = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;

      if (isRefCallback(floatingPanelRef)) return floatingPanelRef(node);

      if (floatingPanelRef) floatingPanelRef.current = node;
    },
    [floatingPanelRef]
  );

  // Clicking the page behind the card dismisses it. Popovers (model picker, history)
  // render in portals outside the card, so their clicks are not "outside".
  useEffect(() => {
    if (mode !== "floating") return;

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target;

      if (!(target instanceof Element) || panelRef.current?.contains(target)) return;

      if (
        target.closest(
          "[data-radix-popper-content-wrapper], [role=menu], [role=listbox], [role=dialog], [data-slot=popover-content], [data-react-aria-top-layer]"
        )
      )
        return;
      onModeChange("hidden");
    };

    document.addEventListener("mousedown", onPointerDown);

    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [mode, onModeChange]);

  useEffect(() => {
    if (mode !== "floating") return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onModeChange("hidden");
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [mode, onModeChange]);

  if (mode === "hidden" && !closing) return null;

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
          onRetrySave={activeConversationId != null ? onRetrySave : undefined}
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
      {(suggestions.length > 0 || followUp) && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-2 pb-1">
          {followUp && (
            <div className="flex flex-col items-start gap-1">
              <button
                type="button"
                onClick={followUp.onPress}
                disabled={!isIdle || followUp.disabled}
                title={followUp.title}
                className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-primary outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-50"
              >
                <Sparkles size={12} className="shrink-0" />
                {followUp.label}
              </button>
              {followUp.error && (
                <span role="alert" className="text-xs text-danger">
                  {followUp.error}
                </span>
              )}
            </div>
          )}
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
        modelPicker={<ChatModelPicker disabled={!isIdle} />}
        autoFocus
      />
    </>
  );

  if (mode === "floating" || closing) {
    return (
      <div
        ref={setPanelRef}
        style={{ height: `min(${height ?? FLOATING_DEFAULT_HEIGHT_PX}px, ${floatingMaxHeight})` }}
        className={cn(
          // Geometry keeps the input where the ask bar was: the bar is 600px wide, 20px from the
          // sides and 16px from the bottom; the input sits 12px inside the card.
          "absolute bottom-1 left-2 right-2 z-20 mx-auto max-w-[624px]",
          "flex flex-col",
          // Translucent enough for the note to show through the blur, like the ask bar.
          "bg-overlay/60 text-overlay-foreground",
          "border border-border",
          // Same radius as the ask bar it replaces, so opening reads as one surface.
          "rounded-[22px]",
          "shadow-overlay",
          "backdrop-blur-xl backdrop-saturate-150 transform-gpu",
          closing
            ? "pointer-events-none motion-safe:animate-out motion-safe:fade-out-0 motion-safe:slide-out-to-bottom-2 motion-safe:duration-150 motion-safe:fill-mode-forwards"
            : "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"
        )}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("embeddedChat.resize")}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onDoubleClick={() => {
            localStorage.removeItem(FLOATING_HEIGHT_KEY);
            setHeight(null);
          }}
          className="absolute inset-x-6 -top-1 z-10 h-3 cursor-ns-resize touch-none"
        />
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
