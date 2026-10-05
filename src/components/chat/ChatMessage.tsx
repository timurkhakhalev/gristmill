import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check, Search, FileText, ChevronDown, ChevronRight, CircleAlert } from "../icons";
import { cn } from "../lib/utils";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { MessageLoading } from "../ui/MessageLoading";
import type { ToolCallInfo } from "./types";
import { extractNoteCards } from "./noteCards";
import { toolIcons } from "./toolIcons";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
  toolCalls?: ToolCallInfo[];
  onOpenNote?: (noteId: number) => void;
}

function ToolCallStep({ toolCall }: { toolCall: ToolCallInfo }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const Icon = toolIcons[toolCall.name] || Search;
  const isExecuting = toolCall.status === "executing";
  const isError = toolCall.status === "error";
  const isCompleted = toolCall.status === "completed";
  const isClipboard = toolCall.name === "copy_to_clipboard" && isCompleted;

  const resultLines = toolCall.result?.split("\n") ?? [];
  const hasDetail = resultLines.length > 1 && !isClipboard;

  return (
    <div
      className={cn(
        "relative rounded-md mb-1 overflow-hidden",
        "border-s-2 transition-colors duration-300",
        isExecuting && "border-s-primary/60",
        isCompleted && !isError && "border-s-border",
        isClipboard && "border-s-success/50",
        isError && "border-s-danger/50"
      )}
    >
      {isExecuting && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ animation: "tool-step-shimmer 2s ease-in-out infinite" }}
        />
      )}

      <div
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1.5",
          "bg-subtle",
          hasDetail && !isExecuting && "cursor-pointer"
        )}
        onClick={hasDetail && !isExecuting ? () => setExpanded((v) => !v) : undefined}
      >
        <Icon
          size={12}
          className={cn(
            "shrink-0 transition-colors duration-300",
            isExecuting && "text-primary/70",
            isCompleted && !isError && !isClipboard && "text-muted",
            isClipboard && "text-success",
            isError && "text-danger"
          )}
        />

        {isExecuting ? (
          <span className="text-2xs text-muted">
            {t(`agentMode.tools.${toolCall.name}Status`, { defaultValue: toolCall.name })}
          </span>
        ) : isError ? (
          <div className="flex items-center gap-1">
            <CircleAlert size={10} className="text-danger shrink-0" />
            <span className="text-2xs text-danger">{toolCall.result || toolCall.name}</span>
          </div>
        ) : isClipboard ? (
          <div className="flex items-center gap-1">
            <span className="text-2xs text-success">{t("agentMode.tools.copiedToClipboard")}</span>
            <Check
              size={10}
              className="text-success shrink-0"
              style={{ animation: "tool-check-pop 300ms ease-out both" }}
            />
          </div>
        ) : (
          <span className="text-2xs text-muted">{toolCall.result || toolCall.name}</span>
        )}

        {hasDetail && !isExecuting && (
          <ChevronDown
            size={10}
            className={cn(
              "ms-auto text-muted shrink-0 transition-transform duration-200",
              expanded && "rotate-180"
            )}
          />
        )}
      </div>

      {hasDetail && !isExecuting && (
        <div
          className="overflow-hidden transition-all duration-200"
          style={{ maxHeight: expanded ? `${resultLines.length * 16 + 12}px` : "0px" }}
        >
          <pre
            dir="ltr"
            className="text-2xs text-muted px-2.5 pb-1.5 whitespace-pre-wrap leading-tight"
          >
            {toolCall.result}
          </pre>
        </div>
      )}
    </div>
  );
}

function CopyButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? t("common.copied") : t("common.copy")}
      title={copied ? t("common.copied") : t("common.copy")}
      className={cn(
        "rounded-md p-1",
        "text-muted hover:bg-default hover:text-foreground",
        "opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-visible:opacity-100",
        "outline-none focus-visible:ring-2 focus-visible:ring-focus"
      )}
    >
      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
    </button>
  );
}

function NoteCard({
  noteId,
  title,
  onOpenNote,
}: {
  noteId: number;
  title: string;
  onOpenNote?: (noteId: number) => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      onClick={() => onOpenNote?.(noteId)}
      className={cn(
        "flex items-center gap-2 w-full mt-2 px-2.5 py-2 rounded-lg",
        "border border-border bg-surface",
        "hover:border-border-hover hover:bg-default",
        "outline-none focus-visible:ring-2 focus-visible:ring-focus",
        "active:scale-[0.99]",
        "transition-all duration-150",
        "text-start group/note"
      )}
    >
      <div className="shrink-0 rounded-md bg-accent-soft p-1">
        <FileText size={12} className="text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p dir="auto" className="text-xs font-medium text-foreground truncate">
          {title}
        </p>
        <p className="text-2xs text-muted">{t("agentMode.tools.openNote")}</p>
      </div>
      <ChevronRight
        size={12}
        className="text-muted group-hover/note:text-primary shrink-0 transition-colors duration-150 rtl:rotate-180"
      />
    </button>
  );
}

export function ChatMessage({
  role,
  content,
  isStreaming,
  toolCalls,
  onOpenNote,
}: ChatMessageProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  if (role === "user") {
    return (
      <div
        className="group/msg flex items-end justify-end gap-1"
        style={{ animation: "agent-message-in 200ms ease-out both" }}
      >
        <CopyButton copied={copied} onCopy={handleCopy} />
        <div
          data-chat-bubble
          className={cn(
            "max-w-[80%] px-3.5 py-2 rounded-2xl",
            "bg-surface-3 text-foreground",
            "text-ui leading-relaxed"
          )}
        >
          <span dir="auto">{content}</span>
        </div>
      </div>
    );
  }

  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const hasContent = content.length > 0;
  const noteCards = extractNoteCards(toolCalls, t("notes.list.untitledNote"));

  return (
    <div
      className="group/msg flex justify-start"
      style={{ animation: "agent-message-in 200ms ease-out both" }}
    >
      <div
        data-chat-bubble
        className={cn("w-full px-0.5 py-1 text-foreground", "text-ui leading-relaxed")}
      >
        {hasToolCalls && (
          <div className={cn((hasContent || noteCards.length > 0) && "mb-2")}>
            {toolCalls.map((tc) => (
              <ToolCallStep key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {hasContent && (
          <MarkdownRenderer
            content={content}
            className="text-ui leading-relaxed [&_p]:text-ui [&_li]:text-ui"
          />
        )}

        {isStreaming && hasContent && (
          <span
            className="inline-block w-0.5 h-3.5 bg-foreground/70 align-middle ms-0.5"
            style={{ animation: "agent-cursor-blink 1s ease-in-out infinite" }}
          />
        )}

        {isStreaming && !hasContent && !hasToolCalls && (
          <MessageLoading className="my-2 text-muted" />
        )}

        {noteCards.length > 0 && !isStreaming && (
          <div>
            {noteCards.map((card) => (
              <NoteCard
                key={card.noteId}
                noteId={card.noteId}
                title={card.title}
                onOpenNote={onOpenNote}
              />
            ))}
          </div>
        )}

        {hasContent && !isStreaming && (
          <div className="mt-1 flex justify-start">
            <CopyButton copied={copied} onCopy={handleCopy} />
          </div>
        )}
      </div>
    </div>
  );
}
