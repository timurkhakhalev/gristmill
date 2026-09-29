import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../hooks/useUiLocale";
import {
  Search,
  FileText,
  Mic,
  Folder,
  Lock,
  Users,
  Upload,
  ChevronDown,
} from "./icons";
import { cn } from "./lib/utils";
import { Dropdown, Label, Modal, Separator } from "@heroui/react";
import type { FolderItem, SpaceItem } from "../contracts/containers";
import type { TranscriptionItem } from "../contracts/transcriptionData.js";
import type { NoteItem, TranscriptSearchHit } from "../contracts/notes";
import { formatRelativeTime } from "../utils/dateFormatting";
import { useDateTimePreferences } from "../hooks/useDateTimePreferences";
import { defaultFolderDisplayName, folderMatchesQuery } from "./notes/shared";

const ALL_SPACES_KEY = "__all__";

interface JumpTarget {
  key: string;
  spaceId: number;
  folderId: number | null;
  label: string;
  space: SpaceItem | undefined;
}

export interface CommandSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transcriptions?: TranscriptionItem[];
  onNoteSelect?: (noteId: number, folderId: number | null, spaceId?: number) => void;
  onContainerSelect?: (spaceId: number, folderId: number | null) => void;
  onTranscriptSelect?: (transcriptId: number) => void;
}

type FlatItem =
  | { kind: "container"; target: JumpTarget }
  | { kind: "note"; note: NoteItem }
  | { kind: "noteTranscript"; hit: TranscriptSearchHit }
  | { kind: "transcript"; transcript: TranscriptionItem };

function stripMarkdownPreview(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
}

export default function CommandSearch({
  open,
  onOpenChange,
  transcriptions = [],
  onNoteSelect,
  onContainerSelect,
  onTranscriptSelect,
}: CommandSearchProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [noteTranscriptHits, setNoteTranscriptHits] = useState<TranscriptSearchHit[]>([]);
  const [searchError, setSearchError] = useState(false);
  const [transcriptSearchPending, setTranscriptSearchPending] = useState(false);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [scopeSpaceId, setScopeSpaceId] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchVersionRef = useRef(0);
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevNotes, setPrevNotes] = useState(notes);
  const [prevQuery, setPrevQuery] = useState(query);

  useEffect(() => {
    window.electronAPI
      .getFolders()
      .then(setFolders)
      .catch(() => {});
    window.electronAPI
      .getSpaces?.()
      .then((items) => setSpaces(items ?? []))
      .catch(() => {});
  }, []);

  if (open && !prevOpen) {
    setPrevOpen(open);
    setQuery("");
    setScopeSpaceId(null);
    setSelectedIndex(0);
  } else if (open !== prevOpen) {
    setPrevOpen(open);
  }

  useEffect(() => {
    if (!open || query.trim()) return;
    const version = searchVersionRef.current;
    window.electronAPI
      .getNotes()
      .then((items) => { if (searchVersionRef.current === version && !query.trim()) setNotes(items); })
      .catch(() => {});
  }, [open, query]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const version = ++searchVersionRef.current;

    if (!query.trim()) {
      setNoteTranscriptHits([]);
      setSearchError(false);
      setTranscriptSearchPending(false);
      window.electronAPI
        .getNotes()
        .then((items) => { if (searchVersionRef.current === version) setNotes(items); })
        .catch(() => {});
      return;
    }

    setNotes([]);
    setNoteTranscriptHits([]);
    setSearchError(false);
    setTranscriptSearchPending(true);
    searchTimerRef.current = setTimeout(() => {
      void window.electronAPI.searchNoteContent(query, scopeSpaceId)
        .then((hits) => { if (searchVersionRef.current === version) setNotes(hits.map((hit) => hit.note)); })
        .catch(() => { if (searchVersionRef.current === version) setSearchError(true); });
      void window.electronAPI.searchNoteTranscripts(query, scopeSpaceId)
        .then((hits) => { if (searchVersionRef.current === version) setNoteTranscriptHits(hits); })
        .catch(() => { if (searchVersionRef.current === version) setSearchError(true); })
        .finally(() => { if (searchVersionRef.current === version) setTranscriptSearchPending(false); });
    }, 200);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query, scopeSpaceId]);

  if (notes !== prevNotes || query !== prevQuery) {
    setPrevNotes(notes);
    setPrevQuery(query);
    setSelectedIndex(0);
  }

  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const spaceMap = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces]);
  const scopeSpace = scopeSpaceId != null ? spaceMap.get(scopeSpaceId) : undefined;

  // Scoping re-filters the visible list immediately, so the keyboard
  // highlight must restart from the top.
  const selectScope = useCallback((spaceId: number | null) => {
    setScopeSpaceId(spaceId);
    setSelectedIndex(0);
  }, []);

  // The search leg scopes at the DB; this also covers browsed (empty-query)
  // results and stale in-flight results after a scope switch.
  const scopedNotes = useMemo(
    () => (scopeSpaceId == null ? notes : notes.filter((n) => n.space_id === scopeSpaceId)),
    [notes, scopeSpaceId]
  );

  const spaceLabel = useCallback(
    (space: SpaceItem) =>
      space.kind === "private"
        ? t("notes.spaces.personal")
        : `${space.emoji ? `${space.emoji} ` : ""}${space.name}`,
    [t]
  );

  const noteBreadcrumb = useCallback(
    (note: NoteItem) => {
      const space = spaceMap.get(note.space_id);
      const folder = note.folder_id != null ? folderMap.get(note.folder_id) : undefined;
      const folderLabel = folder ? defaultFolderDisplayName(folder, t) : "";
      if (!space) return folderLabel;
      return folder ? `${spaceLabel(space)} / ${folderLabel}` : spaceLabel(space);
    },
    [spaceMap, folderMap, spaceLabel, t]
  );

  const jumpTargets = useMemo<JumpTarget[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const targets: JumpTarget[] = [];
    for (const space of spaces) {
      const label = spaceLabel(space);
      if (label.toLowerCase().includes(q)) {
        targets.push({ key: `s:${space.id}`, spaceId: space.id, folderId: null, label, space });
      }
    }
    for (const folder of folders) {
      if (folderMatchesQuery(folder, t, q)) {
        targets.push({
          key: `f:${folder.id}`,
          spaceId: folder.space_id,
          folderId: folder.id,
          label: defaultFolderDisplayName(folder, t),
          space: spaceMap.get(folder.space_id),
        });
      }
    }
    return targets.slice(0, 5);
  }, [query, spaces, folders, spaceMap, spaceLabel, t]);

  const filteredTranscripts = useMemo(() => {
    const slice = query.trim()
      ? transcriptions.filter((tr) => tr.text.toLowerCase().includes(query.toLowerCase()))
      : transcriptions;
    return slice.slice(0, 5);
  }, [transcriptions, query]);

  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    for (const target of jumpTargets) items.push({ kind: "container", target });
    for (const note of scopedNotes) items.push({ kind: "note", note });
    for (const hit of noteTranscriptHits) items.push({ kind: "noteTranscript", hit });
    for (const transcript of filteredTranscripts) items.push({ kind: "transcript", transcript });
    return items;
  }, [jumpTargets, scopedNotes, noteTranscriptHits, filteredTranscripts]);

  const selectItem = useCallback(
    (item: FlatItem) => {
      if (item.kind === "container") onContainerSelect?.(item.target.spaceId, item.target.folderId);
      else if (item.kind === "note")
        onNoteSelect?.(item.note.id, item.note.folder_id ?? null, item.note.space_id);
      else if (item.kind === "noteTranscript")
        onNoteSelect?.(item.hit.note.id, item.hit.note.folder_id ?? null, item.hit.note.space_id);
      else if (item.kind === "transcript") onTranscriptSelect?.(item.transcript.id);
      onOpenChange(false);
    },
    [onNoteSelect, onContainerSelect, onTranscriptSelect, onOpenChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flatItems[selectedIndex];
        if (item) selectItem(item);
      }
    },
    [flatItems, selectedIndex, selectItem]
  );

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const hasResults = flatItems.length > 0;
  return (
    <Modal isOpen={open} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container placement="center">
          <Modal.Dialog
            aria-label={t("commandSearch.title")}
            className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-overlay p-0 text-overlay-foreground shadow-overlay"
          >

          {/* Search input */}
          <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-border/70">
            <Search size={14} className="shrink-0 text-muted" />
            {spaces.length > 1 && (
              <Dropdown>
                <Dropdown.Trigger
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-md border border-border bg-subtle",
                    "px-1.5 py-0.5 text-2xs outline-none transition-colors data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus",
                    scopeSpace ? "text-foreground" : "text-muted hover:text-foreground"
                  )}
                >
                  <span className="max-w-32 truncate">
                    {scopeSpace ? <span dir="auto">{spaceLabel(scopeSpace)}</span> : t("commandSearch.allSpaces")}
                  </span>
                  <ChevronDown size={11} className="shrink-0 text-muted" />
                </Dropdown.Trigger>
                <Dropdown.Popover placement="bottom start">
                  <Dropdown.Menu
                    aria-label={t("commandSearch.allSpaces")}
                    selectionMode="single"
                    selectedKeys={[scopeSpace ? String(scopeSpace.id) : ALL_SPACES_KEY]}
                    onAction={(key) => {
                      selectScope(key === ALL_SPACES_KEY ? null : spaces.find((space) => String(space.id) === key)?.id ?? null);
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                  >
                    <Dropdown.Item id={ALL_SPACES_KEY} textValue={t("commandSearch.allSpaces")}>
                      <Label>{t("commandSearch.allSpaces")}</Label>
                      <Dropdown.ItemIndicator />
                    </Dropdown.Item>
                    <Separator className="my-1" />
                    {spaces.map((space) => (
                      <Dropdown.Item key={space.id} id={String(space.id)} textValue={spaceLabel(space)}>
                        <Label dir="auto">{spaceLabel(space)}</Label>
                        <Dropdown.ItemIndicator />
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            )}
            <input
              dir="auto"
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("commandSearch.placeholder")}
              autoFocus
              className="flex-1 text-sm text-foreground placeholder:text-muted"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                boxShadow: "none",
                padding: 0,
              }}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="text-2xs text-muted hover:text-muted-foreground transition-colors outline-none"
              >
                ✕
              </button>
            )}
          </div>

          {/* Results list */}
          <div ref={listRef} className="overflow-y-auto max-h-[340px] p-1.5">
            {!hasResults ? (
              <div className="flex items-center justify-center py-10">
                <p className="text-xs text-muted">
                  {searchError ? t("commandSearch.searchError", { defaultValue: "Search failed" }) : transcriptSearchPending ? t("commandSearch.searchingTranscripts", { defaultValue: "Searching transcripts…" }) : query.trim()
                    ? t("commandSearch.noResults")
                    : t("commandSearch.emptyState")}
                </p>
              </div>
            ) : (
              <>
                {jumpTargets.length > 0 && (
                  <div>
                    <SectionHeader
                      icon={<Folder size={11} />}
                      label={t("commandSearch.sections.jumpTo")}
                    />
                    {jumpTargets.map((target) => {
                      const idx = flatItems.findIndex(
                        (fi) => fi.kind === "container" && fi.target.key === target.key
                      );
                      return (
                        <ContainerRow
                          key={target.key}
                          target={target}
                          showSpaceHint={target.folderId != null && spaces.length > 1}
                          spaceLabel={spaceLabel}
                          idx={idx}
                          isSelected={selectedIndex === idx}
                          onSelect={() => selectItem({ kind: "container", target })}
                          onHover={() => setSelectedIndex(idx)}
                        />
                      );
                    })}
                  </div>
                )}

                {scopedNotes.length > 0 && (
                  <div className={jumpTargets.length > 0 ? "mt-0.5" : ""}>
                    <SectionHeader
                      icon={<FileText size={11} />}
                      label={t("commandSearch.sections.notes")}
                    />
                    {scopedNotes.map((note) => {
                      const idx = flatItems.findIndex(
                        (fi) => fi.kind === "note" && fi.note.id === note.id
                      );
                      return (
                        <NoteRow
                          key={note.id}
                          note={note}
                          breadcrumb={noteBreadcrumb(note)}
                          idx={idx}
                          isSelected={selectedIndex === idx}
                          onSelect={() => selectItem({ kind: "note", note })}
                          onHover={() => setSelectedIndex(idx)}
                          t={t}
                          locale={locale}
                        />
                      );
                    })}
                  </div>
                )}

                {noteTranscriptHits.length > 0 && (
                  <div className="mt-0.5">
                    <SectionHeader icon={<Mic size={11} />} label={t("commandSearch.sections.transcripts")} />
                    {noteTranscriptHits.map((hit) => {
                      const idx = flatItems.findIndex((item) => item.kind === "noteTranscript" && item.hit.note.id === hit.note.id);
                      return (
                        <button key={hit.note.id} type="button" data-idx={idx}
                          onClick={() => selectItem({ kind: "noteTranscript", hit })}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          className={cn("w-full rounded-lg px-2.5 py-2 text-start", selectedIndex === idx ? "bg-primary/8" : "hover:bg-default")}>
                          <span className="block truncate text-sm">{hit.note.title}</span>
                          <span className="block truncate text-xs text-muted">{hit.matches[0]?.snippet}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {searchError && <p className="px-2.5 py-2 text-xs text-destructive">{t("commandSearch.searchError", { defaultValue: "Search failed" })}</p>}
                {transcriptSearchPending && <p className="px-2.5 py-2 text-xs text-muted">{t("commandSearch.searchingTranscripts", { defaultValue: "Searching transcripts…" })}</p>}

                {filteredTranscripts.length > 0 && (
                  <div className={jumpTargets.length > 0 || scopedNotes.length > 0 ? "mt-0.5" : ""}>
                    <SectionHeader
                      icon={<Mic size={11} />}
                      label={t("commandSearch.sections.transcripts")}
                    />
                    {filteredTranscripts.map((transcript) => {
                      const idx = flatItems.findIndex(
                        (fi) => fi.kind === "transcript" && fi.transcript.id === transcript.id
                      );
                      return (
                        <TranscriptRow
                          key={transcript.id}
                          transcript={transcript}
                          idx={idx}
                          isSelected={selectedIndex === idx}
                          onSelect={() => selectItem({ kind: "transcript", transcript })}
                          onHover={() => setSelectedIndex(idx)}
                          t={t}
                          locale={locale}
                        />
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-4 px-3.5 py-2 border-t border-border/70 bg-subtle/15">
            <FooterHint keys={["↑", "↓"]} label={t("commandSearch.footer.navigate")} />
            <FooterHint keys={["↵"]} label={t("commandSearch.footer.open")} />
            <FooterHint keys={["Esc"]} label={t("commandSearch.footer.dismiss")} />
          </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
      <span className="text-muted">{icon}</span>
      <span className="text-2xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </span>
    </div>
  );
}

function ContainerRow({
  target,
  showSpaceHint,
  spaceLabel,
  idx,
  isSelected,
  onSelect,
  onHover,
}: {
  target: JumpTarget;
  showSpaceHint: boolean;
  spaceLabel: (space: SpaceItem) => string;
  idx: number;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const { space } = target;
  const iconClass = cn(
    "shrink-0 transition-colors",
    isSelected ? "text-primary" : "text-muted"
  );
  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        "group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-start transition-colors duration-100 outline-none",
        isSelected
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-default dark:hover:bg-white/4"
      )}
    >
      {target.folderId != null ? (
        <Folder size={13} className={iconClass} />
      ) : space?.kind === "private" ? (
        <Lock size={13} className={iconClass} />
      ) : space?.emoji ? (
        <span className="text-ui leading-none shrink-0" aria-hidden="true">
          {space.emoji}
        </span>
      ) : (
        <Users size={13} className={iconClass} />
      )}
      <p dir="auto" className="flex-1 text-xs font-medium text-foreground truncate min-w-0">
        {target.label}
      </p>
      {showSpaceHint && space && (
        <span
          dir="auto"
          className="text-2xs text-muted truncate shrink-0 max-w-32"
        >
          {spaceLabel(space)}
        </span>
      )}
    </button>
  );
}

function NoteRow({
  note,
  breadcrumb,
  idx,
  isSelected,
  onSelect,
  onHover,
  t,
  locale,
}: {
  note: NoteItem;
  breadcrumb: string;
  idx: number;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  locale?: string;
}) {
  const { dateFormat } = useDateTimePreferences();
  const preview = stripMarkdownPreview(note.content).slice(0, 90);
  const NoteIcon =
    note.note_type === "meeting" ? Users : note.note_type === "upload" ? Upload : FileText;
  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        "group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-start transition-colors duration-100 outline-none",
        isSelected
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-default dark:hover:bg-white/4"
      )}
    >
      <NoteIcon
        size={13}
        className={cn(
          "shrink-0 mt-px transition-colors",
          isSelected ? "text-primary" : "text-muted"
        )}
      />
      <div className="flex-1 min-w-0">
        <p
          dir="auto"
          className={cn(
            "text-xs font-medium truncate",
            note.title ? "text-foreground" : "italic text-muted"
          )}
        >
          {note.title || t("notes.list.untitled")}
        </p>
        {(breadcrumb || preview) && (
          <p className="text-2xs truncate mt-px">
            {breadcrumb && (
              <span dir="auto" className="text-muted">
                {breadcrumb}
              </span>
            )}
            {breadcrumb && preview && <span className="text-muted"> · </span>}
            {preview && (
              <span dir="auto" className="text-muted">
                {preview}
              </span>
            )}
          </p>
        )}
      </div>
      <span className="text-2xs text-muted tabular-nums shrink-0">
        {formatRelativeTime(note.updated_at, t, locale, dateFormat)}
      </span>
    </button>
  );
}

function TranscriptRow({
  transcript,
  idx,
  isSelected,
  onSelect,
  onHover,
  t,
  locale,
}: {
  transcript: TranscriptionItem;
  idx: number;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  locale?: string;
}) {
  const { dateFormat } = useDateTimePreferences();
  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        "group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-start transition-colors duration-100 outline-none",
        isSelected
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-default dark:hover:bg-white/4"
      )}
    >
      <Mic
        size={13}
        className={cn(
          "shrink-0 mt-px transition-colors",
          isSelected ? "text-primary" : "text-muted"
        )}
      />
      <p dir="auto" className="flex-1 text-xs text-foreground/75 truncate min-w-0">
        {transcript.text}
      </p>
      <span className="text-2xs text-muted tabular-nums shrink-0">
        {formatRelativeTime(transcript.created_at, t, locale, dateFormat)}
      </span>
    </button>
  );
}

function FooterHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span dir="ltr" className="inline-flex items-center gap-1">
        {keys.map((k) => (
          <kbd
            key={k}
            className="text-2xs px-1 py-px rounded border border-border/70 bg-subtle/50 text-muted font-mono leading-tight"
          >
            {k}
          </kbd>
        ))}
      </span>
      <span className="text-2xs text-muted ms-0.5">{label}</span>
    </div>
  );
}
