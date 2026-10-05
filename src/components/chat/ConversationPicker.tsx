import { ChevronDown, Clock, Plus } from "../icons";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";
import type { ConversationRow } from "../../contracts/chatPersistence";
import { formatRelativeTime } from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";
import { cn } from "../lib/utils";
import { Dropdown, Label, Separator } from "@heroui/react";

const NEW_CHAT_KEY = "__new_chat__";

interface ConversationPickerProps {
  conversations: ConversationRow[];
  activeConversationId?: number | null;
  onSwitchConversation: (id: number) => void;
  onNewChat?: () => void;
  titleClassName?: string;
  /** "history" shows a clock icon instead of the active conversation's title. */
  variant?: "title" | "history";
  onOpenChange?: (open: boolean) => void;
}

export function ConversationPicker({
  conversations,
  activeConversationId,
  onSwitchConversation,
  onNewChat,
  titleClassName,
  variant = "title",
  onOpenChange,
}: ConversationPickerProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const { dateFormat } = useDateTimePreferences();
  const activeConversation = conversations.find((item) => item.id === activeConversationId);

  return (
    <Dropdown onOpenChange={onOpenChange}>
      <Dropdown.Trigger
        className="-ms-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-foreground outline-none transition-colors duration-150 hover:bg-default data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus"
        aria-label={t("embeddedChat.conversationSelector")}
      >
        {variant === "history" ? (
          <Clock size={15} className="shrink-0 text-muted" />
        ) : (
          <span className={cn("max-w-40 truncate", titleClassName)}>
            {activeConversation?.title || t("embeddedChat.newChat")}
          </span>
        )}
        <ChevronDown size={12} className="shrink-0 text-muted" />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start" className="min-w-52 max-w-72">
        <Dropdown.Menu
          aria-label={t("embeddedChat.conversationSelector")}
          selectionMode="single"
          selectedKeys={activeConversationId != null ? [String(activeConversationId)] : []}
          onAction={(key) => {
            if (key === NEW_CHAT_KEY) onNewChat?.();
            else onSwitchConversation(Number(key));
          }}
        >
          <Dropdown.Item id={NEW_CHAT_KEY} textValue={t("embeddedChat.newChat")}>
            <Plus size={14} className="shrink-0 text-muted" />
            <Label>{t("embeddedChat.newChat")}</Label>
          </Dropdown.Item>
          {conversations.length > 0 && <Separator className="my-1" />}
          {conversations.map((conversation) => (
            <Dropdown.Item
              key={conversation.id}
              id={String(conversation.id)}
              textValue={conversation.title || t("embeddedChat.newChat")}
            >
              <Label className="min-w-0 flex-1 truncate">
                {conversation.title || t("embeddedChat.newChat")}
              </Label>
              <span className="shrink-0 text-2xs text-muted">
                {formatRelativeTime(conversation.updated_at, t, locale, dateFormat, { ago: true })}
              </span>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
