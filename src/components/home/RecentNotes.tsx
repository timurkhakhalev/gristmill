import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dropdown, Label, Separator } from "@heroui/react";
import { FileText, FolderOpen, Trash2 } from "../icons";
import { MoveFolderPicker, RowMenu } from "../notes/SpacesTree";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { useFolders, useSpaces } from "../../stores/noteStore";
import type { NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import PersonAvatar from "../ui/PersonAvatar";
import { useUiLocale } from "../../hooks/useUiLocale";
import { formatDate, formatTime, normalizeDbDate } from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";
import type { CalendarAttendee } from "../../contracts/calendar";
import type { NoteItem } from "../../contracts/notes";

// Names spelled out before collapsing the rest into "& N others".
const MAX_NAMED_PARTICIPANTS = 2;

function parseParticipants(raw: string | null): CalendarAttendee[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function participantName(person: CalendarAttendee): string {
  return person.displayName || person.email?.split("@")[0] || "";
}

interface DayGroup {
  key: string;
  date: Date;
  notes: NoteItem[];
}

/** Buckets notes by the local calendar day they were created, newest first. */
function groupNotesByDay(notes: NoteItem[]): DayGroup[] {
  const dated = notes
    .map((note) => ({ note, date: normalizeDbDate(note.created_at) }))
    .filter(({ date }) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const groups: DayGroup[] = [];

  for (const { note, date } of dated) {
    const key = date.toDateString();
    const last = groups[groups.length - 1];

    if (last?.key === key) last.notes.push(note);
    else groups.push({ key, date, notes: [note] });
  }

  return groups;
}

interface NoteRowProps {
  note: NoteItem;
  onOpen: () => void;
  onMove: (noteId: number, target: NoteMoveTarget) => void;
  onCreateFolderAndMove: (noteId: number, name: string) => void;
  onDelete: (noteId: number) => void;
}

function NoteRow({ note, onOpen, onMove, onCreateFolderAndMove, onDelete }: NoteRowProps) {
  const { t } = useTranslation();
  const spaces = useSpaces();
  const folders = useFolders();
  const [moveOpen, setMoveOpen] = useState(false);
  const locale = useUiLocale();
  const { timeFormat } = useDateTimePreferences();

  const others = useMemo(
    () => parseParticipants(note.participants).filter((p) => !p.self && participantName(p)),
    [note.participants]
  );

  const lead = others[0];
  const named = others.slice(0, MAX_NAMED_PARTICIPANTS).map(participantName);
  const rest = others.length - named.length;

  const subtitle =
    others.length === 0
      ? note.note_type === "meeting"
        ? t("home.recent.meeting")
        : null
      : rest > 0
        ? t("home.recent.participantsMore", { names: named.join(", "), count: rest })
        : named.join(", ");

  const time = formatTime(
    normalizeDbDate(note.created_at),
    locale,
    {
      hour: "numeric",
      minute: "2-digit",
    },
    timeFormat
  );

  return (
    <Popover open={moveOpen} onOpenChange={setMoveOpen}>
      <PopoverAnchor>
        <div className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-1 rounded-lg pe-2 transition-colors duration-150 hover:bg-default dark:hover:bg-white/4">
          <button
            onClick={onOpen}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-start focus:outline-none focus-visible:ring-1 focus-visible:ring-focus"
          >
            {lead ? (
              <PersonAvatar
                email={lead.email}
                displayName={lead.displayName}
                size={32}
                className="rounded-lg"
              />
            ) : (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-muted-foreground">
                <FileText size={14} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block truncate text-sm font-medium text-foreground">
                {note.title || t("notes.list.untitled")}
              </span>
              {subtitle && (
                <span dir="auto" className="block truncate text-xs text-muted-foreground">
                  {subtitle}
                </span>
              )}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{time}</span>
          </button>
          <RowMenu
            label={t("common.actions")}
            onAction={(key) => {
              if (key === "move") setMoveOpen(true);
              else if (key === "delete") onDelete(note.id);
            }}
          >
            <Dropdown.Item id="move" textValue={t("notes.context.moveToFolder")}>
              <FolderOpen size={14} className="shrink-0 text-muted" />
              <Label>{t("notes.context.moveToFolder")}…</Label>
            </Dropdown.Item>
            <Separator className="my-1" />
            <Dropdown.Item id="delete" variant="danger" textValue={t("notes.context.delete")}>
              <Trash2 size={14} className="shrink-0" />
              <Label>{t("notes.context.delete")}</Label>
            </Dropdown.Item>
          </RowMenu>
        </div>
      </PopoverAnchor>
      <PopoverContent align="end" className="w-64 p-2">
        <MoveFolderPicker
          note={note}
          spaces={spaces}
          folders={folders}
          onMove={(target) => onMove(note.id, target)}
          onCreateFolderAndMove={onCreateFolderAndMove}
          onDone={() => setMoveOpen(false)}
          t={t}
        />
      </PopoverContent>
    </Popover>
  );
}

interface RecentNotesProps {
  notes: NoteItem[];
  onOpenNote: (note: NoteItem) => void;
  onMoveNote: NoteRowProps["onMove"];
  onCreateFolderAndMove: NoteRowProps["onCreateFolderAndMove"];
  onDeleteNote: NoteRowProps["onDelete"];
}

/** Past notes and meetings across every space, grouped by day. */
export default function RecentNotes({
  notes,
  onOpenNote,
  onMoveNote,
  onCreateFolderAndMove,
  onDeleteNote,
}: RecentNotesProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const { dateFormat } = useDateTimePreferences();
  const groups = useMemo(() => groupNotesByDay(notes), [notes]);

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const dayLabel = (date: Date) => {
    if (date.toDateString() === today.toDateString()) return t("home.today");

    if (date.toDateString() === yesterday.toDateString()) return t("home.yesterday");

    return formatDate(
      date,
      locale,
      {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(date.getFullYear() !== today.getFullYear() && { year: "numeric" }),
      },
      dateFormat
    );
  };

  if (groups.length === 0) {
    return <p className="py-6 text-center text-xs text-muted">{t("home.recent.empty")}</p>;
  }

  return (
    <section className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.key}>
          <h3 className="pb-1 text-xs font-medium text-muted-foreground">{dayLabel(group.date)}</h3>
          {group.notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              onOpen={() => onOpenNote(note)}
              onMove={onMoveNote}
              onCreateFolderAndMove={onCreateFolderAndMove}
              onDelete={onDeleteNote}
            />
          ))}
        </div>
      ))}
    </section>
  );
}
