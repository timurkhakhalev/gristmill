import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";
import { Search, FileText, Check } from "../icons";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { formatDateGroup, type DateFormat } from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";
import type { NoteItem } from "../../contracts/notes";
import { runInBackground } from "../../stores/noteStore";

interface AddNotesToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetFolderId: number;
  onNotesAdded: () => void;
}

function groupNotesByDate(
  notes: NoteItem[],
  t: (key: string) => string,
  locale: string,
  dateFormat: DateFormat
): [string, NoteItem[]][] {
  const groups = new Map<string, NoteItem[]>();

  for (const note of notes) {
    const key = formatDateGroup(note.updated_at, t, locale, dateFormat);
    const arr = groups.get(key) || [];
    arr.push(note);
    groups.set(key, arr);
  }

  return Array.from(groups.entries());
}

export default function AddNotesToFolderDialog({
  open,
  onOpenChange,
  targetFolderId,
  onNotesAdded,
}: AddNotesToFolderDialogProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const { dateFormat } = useDateTimePreferences();
  const [allNotes, setAllNotes] = useState<NoteItem[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelected(new Set());
    runInBackground(
      window.electronAPI.getNotes(null, 500, null).then(setAllNotes),
      "Load notes for folder failed"
    );
  }, [open]);

  const availableNotes = useMemo(
    () => allNotes.filter((n) => !n.folder_ids.includes(targetFolderId)),
    [allNotes, targetFolderId]
  );

  const filteredNotes = useMemo(() => {
    if (!search.trim()) return availableNotes;
    const q = search.toLowerCase();

    return availableNotes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
    );
  }, [availableNotes, search]);

  const grouped = useMemo(
    () => groupNotesByDate(filteredNotes, t, locale, dateFormat),
    [filteredNotes, t, locale, dateFormat]
  );

  const toggleNote = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  }, []);

  const handleAdd = useCallback(async () => {
    if (selected.size === 0) return;
    setIsAdding(true);

    try {
      const notesById = new Map(allNotes.map((n) => [n.id, n]));
      await Promise.all(
        Array.from(selected).map((id) => {
          const note = notesById.get(id);

          return note
            ? window.electronAPI.updateNote(id, {
                folder_ids: [...note.folder_ids, targetFolderId],
              })
            : Promise.resolve();
        })
      );
      onNotesAdded();
      onOpenChange(false);
    } finally {
      setIsAdding(false);
    }
  }, [selected, targetFolderId, allNotes, onNotesAdded, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{t("notes.addToFolder.title")}</DialogTitle>

        <div className="px-4 pe-12 pt-4 pb-2">
          <div className="relative">
            <Search size={13} className="absolute start-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              dir="auto"
              placeholder={t("notes.addToFolder.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-8 rounded-md bg-foreground/[0.03] dark:bg-white/[0.04] border border-foreground/8 dark:border-white/10 ps-8 pe-3 text-xs text-foreground placeholder:text-muted outline-none focus:border-primary/30 transition-colors"
              autoFocus
            />
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto px-2 pb-2">
          {grouped.length === 0 ? (
            <div className="flex items-center justify-center py-10">
              <p className="text-xs text-muted">
                {search
                  ? t("notes.addToFolder.noResults")
                  : t("notes.addToFolder.noNotesAvailable")}
              </p>
            </div>
          ) : (
            grouped.map(([dateLabel, notes]) => (
              <div key={dateLabel}>
                <p className="text-xs font-medium text-muted px-2 pt-3 pb-1.5">{dateLabel}</p>
                {notes.map((note) => {
                  const isSelected = selected.has(note.id);

                  return (
                    <button
                      key={note.id}
                      onClick={() => toggleNote(note.id)}
                      className={cn(
                        "w-full flex items-center gap-3 px-2 py-2 rounded-md transition-colors",
                        "hover:bg-default dark:hover:bg-white/3",
                        isSelected && "bg-primary/5 dark:bg-primary/8"
                      )}
                    >
                      <div className="w-7 h-7 rounded-md bg-foreground/[0.03] dark:bg-white/[0.04] border border-foreground/6 dark:border-white/10 flex items-center justify-center shrink-0">
                        <FileText size={12} className="text-muted" />
                      </div>
                      <div className="flex-1 min-w-0 text-start">
                        <p className="text-xs text-foreground/80 truncate">
                          {note.title || t("notes.list.untitled")}
                        </p>
                      </div>
                      <div
                        className={cn(
                          "w-4 h-4 rounded-sm border shrink-0 flex items-center justify-center transition-colors",
                          isSelected
                            ? "bg-accent border-accent"
                            : "border-foreground/15 dark:border-white/15"
                        )}
                      >
                        {isSelected && <Check size={10} className="text-white" strokeWidth={2.5} />}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-3 border-t border-border flex justify-end">
          <Button
            variant="default"
            size="sm"
            onClick={() => runInBackground(handleAdd(), "Add notes to folder failed")}
            disabled={selected.size === 0 || isAdding}
            className="h-7 text-xs"
          >
            {t("notes.addToFolder.addCount", { count: selected.size })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
