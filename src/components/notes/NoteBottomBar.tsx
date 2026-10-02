import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { SendIcon } from "../ui/SendIcon";
import { GLASS_SURFACE } from "../ui/glass";
import ChatModelPicker from "../chat/ChatModelPicker";
import { ConversationPicker } from "../chat/ConversationPicker";
import type { ConversationRow } from "../../contracts/chatPersistence";
import { prefetchBbCatalog } from "../bb/useBbCatalog";
import { useSettingsStore } from "../../stores/settingsStore";
import { selectResolvedLLMConfig } from "../../config/settingsSelectors";

// While recording, the bar sits over the live streaming transcript, and every
// partial would force backdrop-blur to re-blur the strip; the capsule trades
// glass for a near-opaque surface until the recording ends.
const RECORDING_SURFACE = "bg-surface-2/95 shadow-(--shadow-glass)";

interface NoteBottomBarProps {
  /** Swaps the glass surface for an opaque one while the live transcript streams underneath. */
  isRecording: boolean;
  onAskSubmit: (text: string) => void;
  onInputFocus?: () => void;
  askDisabled?: boolean;
  /** One centred call to action floated above the ask capsule. */
  callout?: React.ReactNode;
  hideInput?: boolean;
  /** Overlay the bar on the content behind it instead of reserving its own row. */
  floating?: boolean;
  /** Previous chats, offered at the left of the focused input. */
  history?: {
    conversations: ConversationRow[];
    activeConversationId?: number | null;
    onSwitchConversation: (id: number) => void;
    onNewChat?: () => void;
  };
}

export default function NoteBottomBar({
  isRecording,
  onAskSubmit,
  onInputFocus,
  askDisabled,
  callout,
  hideInput,
  floating = false,
  history,
}: NoteBottomBarProps) {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasText = inputText.trim().length > 0;

  // The model row mounts on focus; warm its data so it paints its final label.
  useEffect(() => {
    prefetchBbCatalog(selectResolvedLLMConfig(useSettingsStore.getState(), "chatIntelligence").agentProvider);
  }, []);

  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text || askDisabled) return;
    onAskSubmit(text);
    setInputText("");
    setIsExpanded(false);
    setIsModelPickerOpen(false);
  }, [inputText, askDisabled, onAskSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape") {
        setIsExpanded(false);
        inputRef.current?.blur();
      }
    },
    [handleSubmit]
  );

  const handleInputFocus = useCallback(() => {
    setIsExpanded(true);
    onInputFocus?.();
  }, [onInputFocus]);

  // Chat panel opening hides the input; drop the expanded state so the bar
  // comes back in its idle layout when the panel closes.
  useEffect(() => {
    if (hideInput) {
      setIsExpanded(false);
      setIsModelPickerOpen(false);
      setIsHistoryOpen(false);
    }
  }, [hideInput]);

  useEffect(() => {
    if (!isExpanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (!hasText && !isModelPickerOpen && !isHistoryOpen && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsExpanded(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded, hasText, isModelPickerOpen, isHistoryOpen]);

  return (
    <div
      ref={containerRef}
      className={cn("px-5 pb-4 pt-3 pointer-events-none", floating ? "absolute inset-x-0 bottom-0 z-10" : "shrink-0")}
    >
      {callout && !hideInput && (
        <div className="pointer-events-auto mb-3 flex justify-center">{callout}</div>
      )}
      <div className="relative flex items-end pointer-events-auto w-full max-w-[600px] mx-auto">
        {/* Separate from the glass capsule: a shadow on the blurred element itself would
            flatten its backdrop-filter, and box-shadow never paints under its own box. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 rounded-[22px] shadow-[0_10px_36px_rgba(0,0,0,0.28)] dark:shadow-[0_10px_40px_rgba(0,0,0,0.6)]",
            "transition-opacity duration-200",
            hideInput && "opacity-0"
          )}
        />
        <div
          aria-hidden={hideInput}
          className={cn(
            "relative flex-1 min-w-0 flex items-center",
            isRecording ? RECORDING_SURFACE : GLASS_SURFACE,
            "border",
            // Only height and opacity tween. A fixed 22px radius is a pill at
            // 44px and a card at 76px, so the outline never morphs; the surface
            // swap must land instantly, or every recording start/stop tweens
            // backdrop-filter. The chat panel replaces the bar with a fade
            // rather than the bar collapsing sideways into it.
            "rounded-[22px] border-border ps-4 pe-1.5",
            "transition-[opacity,box-shadow] duration-200 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
            hideInput ? "opacity-0 pointer-events-none" : "opacity-100",
            "h-11",
            isExpanded && "ring-[3px] ring-primary/8"
          )}
          onClick={(e) => {
            if (e.target === e.currentTarget) inputRef.current?.focus();
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isExpanded && !hideInput && history && history.conversations.length > 0 && (
              <ConversationPicker
                variant="history"
                conversations={history.conversations}
                activeConversationId={history.activeConversationId}
                onSwitchConversation={history.onSwitchConversation}
                onNewChat={history.onNewChat}
                onOpenChange={(open) => {
                  setIsHistoryOpen(open);
                  if (!open && !hasText) setIsExpanded(false);
                }}
              />
            )}
            <input
              dir="auto"
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={handleInputFocus}
              disabled={askDisabled}
              tabIndex={hideInput ? -1 : undefined}
              placeholder={t("embeddedChat.askPlaceholder")}
              className={cn(
                "input-inline flex-1 bg-transparent outline-none min-w-0 p-0 caret-primary",
                "text-ui text-foreground",
                "placeholder:text-muted dark:placeholder:text-muted"
              )}
            />

            {isExpanded && !hideInput && (
              <ChatModelPicker
                disabled={askDisabled}
                onOpenChange={(open) => {
                  setIsModelPickerOpen(open);
                  if (!open && !hasText) setIsExpanded(false);
                }}
              />
            )}

            {hasText ? (
              <button
                onClick={handleSubmit}
                disabled={askDisabled}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                  "animate-[scale-in_0.15s_ease-out_backwards]",
                  "transition-all duration-150",
                  "hover:brightness-110",
                  "active:scale-90",
                  "disabled:opacity-30"
                )}
                aria-label={t("embeddedChat.send")}
              >
                <SendIcon size={28} className="block rtl:scale-x-[-1]" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
