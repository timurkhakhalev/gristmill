import { useMemo } from "react";
import { FileText, Plus } from "../../icons";
import { useTranslation } from "react-i18next";
import { groupItemsByDate } from "../../../utils/dateGrouping";
import type { SpaceItem } from "../../../contracts/containers";
import type { NoteItem } from "../../../contracts/notes";

interface OverviewNoteListProps {
  notes: NoteItem[];
  space: SpaceItem;
  onOpenNote: (noteId: number) => void;
  onNewNote: () => void;
  onAddExisting?: () => void;
}

export function OverviewNoteList({
  notes,
  space,
  onOpenNote,
  onNewNote,
  onAddExisting,
}: OverviewNoteListProps) {
  const { t } = useTranslation();

  const groups = useMemo(() => groupItemsByDate(notes, (n) => n.updated_at, t), [notes, t]);

  if (notes.length === 0) {
    return (
      <div className="flex flex-col items-center py-8">
        <p className="text-xs text-foreground/45 dark:text-foreground/45 mb-3">
          {t("notes.overview.list.empty")}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onNewNote}
            className="flex items-center gap-1.5 px-4 h-7 rounded-md bg-primary/8 dark:bg-primary/10 border border-primary/12 dark:border-primary/15 text-xs font-medium text-primary/70 hover:bg-primary/12 hover:text-primary hover:border-primary/20 transition-colors"
          >
            <Plus size={11} />
            {t("notes.empty.createNote")}
          </button>
          {onAddExisting && (
            <button
              onClick={onAddExisting}
              className="flex items-center gap-1.5 px-4 h-7 rounded-md border border-foreground/8 dark:border-white/10 text-xs text-foreground/45 hover:text-foreground/60 hover:border-foreground/15 hover:bg-foreground/3 dark:hover:bg-white/3 transition-colors"
            >
              {t("notes.addToFolder.addExisting")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pb-6">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="pt-4 pb-1 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider select-none">
            {group.label}
          </div>
          {group.items.map((note) => (
              <button
                key={note.id}
                onClick={() => onOpenNote(note.id)}
                className="w-full flex items-center gap-3 px-2 py-2 -mx-2 rounded-md text-start hover:bg-foreground/4 dark:hover:bg-white/4 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
              >
                <FileText
                  size={14}
                  className="text-foreground/45 dark:text-foreground/45 shrink-0"
                />
                <span className="text-[13px] text-foreground/85 truncate flex-1">
                  {note.title || t("notes.list.untitled")}
                </span>
                <span className="text-[11px] text-foreground/45 dark:text-foreground/45 shrink-0 tabular-nums">{note.updated_at}</span>
              </button>
          ))}
        </div>
      ))}
    </div>
  );
}
