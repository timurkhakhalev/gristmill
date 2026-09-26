import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, ChevronUp, ChevronDown, X } from "../icons";
import { cn } from "../lib/utils";
import { findRanges } from "../../utils/findMatches";

const MATCH_HIGHLIGHT = "note-find-match";
const ACTIVE_HIGHLIGHT = "note-find-active";

/** Find-in-note bar. Matches live under `containerRef` and are painted with
 * the CSS Custom Highlight API, so the editor selection and undo history are
 * never touched. */
export default function NoteFindBar({
  open,
  onClose,
  containerRef,
}: {
  open: boolean;
  onClose: () => void;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const ranges = useMemo(() => {
    const root = containerRef.current;
    if (!open || !query || !root) return [];
    return findRanges(root, query);
  }, [open, query, containerRef]);

  const clearHighlights = useCallback(() => {
    const highlights = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
    highlights?.delete(MATCH_HIGHLIGHT);
    highlights?.delete(ACTIVE_HIGHLIGHT);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const highlights = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
    setMatchCount(ranges.length);
    if (!highlights) return;
    if (ranges.length === 0) {
      clearHighlights();
      return;
    }
    const active = ranges[Math.min(activeIndex, ranges.length - 1)];
    highlights.set(MATCH_HIGHLIGHT, new Highlight(...ranges));
    highlights.set(ACTIVE_HIGHLIGHT, new Highlight(active));
    const scroller = containerRef.current;
    const rect = active.getBoundingClientRect();
    const scrollerRect = scroller?.getBoundingClientRect();
    if (scroller && scrollerRect) {
      const offset = rect.top - scrollerRect.top;
      if (offset < 0 || offset > scroller.clientHeight - rect.height) {
        scroller.scrollTop += offset - scroller.clientHeight / 2;
      }
    }
    return clearHighlights;
  }, [ranges, activeIndex, clearHighlights, containerRef]);

  useEffect(() => clearHighlights, [clearHighlights]);

  const step = useCallback(
    (delta: number) => {
      setActiveIndex((index) => {
        if (ranges.length === 0) return 0;
        return (index + delta + ranges.length) % ranges.length;
      });
    },
    [ranges.length]
  );

  if (!open) return null;

  const noMatches = query.length > 0 && matchCount === 0;

  return (
    <div className="absolute end-3 top-3 z-30 flex items-center gap-1 rounded-lg border border-border bg-overlay p-1 shadow-overlay">
      <Search size={13} className="ms-1.5 shrink-0 text-muted" />
      <input
        dir="auto"
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={t("notes.find.placeholder", "Find in note")}
        aria-label={t("notes.find.placeholder", "Find in note")}
        className="w-44 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
      />
      <span
        className={cn("shrink-0 px-1 text-2xs tabular-nums", noMatches ? "text-danger" : "text-muted")}
      >
        {query ? `${matchCount === 0 ? 0 : Math.min(activeIndex + 1, matchCount)}/${matchCount}` : ""}
      </span>
      <button
        type="button"
        aria-label={t("notes.find.previous", "Previous match")}
        onClick={() => step(-1)}
        disabled={matchCount === 0}
        className="rounded p-1 text-muted transition-colors hover:text-foreground disabled:opacity-40"
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        aria-label={t("notes.find.next", "Next match")}
        onClick={() => step(1)}
        disabled={matchCount === 0}
        className="rounded p-1 text-muted transition-colors hover:text-foreground disabled:opacity-40"
      >
        <ChevronDown size={13} />
      </button>
      <button
        type="button"
        aria-label={t("common.close", "Close")}
        onClick={onClose}
        className="rounded p-1 text-muted transition-colors hover:text-foreground"
      >
        <X size={13} />
      </button>
    </div>
  );
}
