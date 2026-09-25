import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, ChevronDown, Users, X } from "../icons";
import { cn } from "../lib/utils";
import { NOTE_META_CHIP_CLASS } from "./shared";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import PersonAvatar from "../ui/PersonAvatar";
import type { CalendarAttendee } from "../../contracts/calendar";
import { syncSessionExpectedCountFromParticipants } from "../../stores/meetingRecordingStore";

const MAX_STACKED_AVATARS = 2;

interface NoteParticipantsProps {
  noteId: number;
  participants: CalendarAttendee[];
  /** When present the capsule leads with the note's date, so date and people read as one fact. */
  dateLabel?: string;
  dateTitle?: string;
  preview?: boolean;
}

export default function NoteParticipants({
  noteId,
  participants,
  dateLabel,
  dateTitle,
  preview = false,
}: NoteParticipantsProps) {
  const { t } = useTranslation();
  const [localParticipants, setLocalParticipants] = useState(participants);
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<
    Array<{ email: string; display_name: string | null }>
  >([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setLocalParticipants(participants);
  }, [participants]);

  useEffect(() => {
    if (!open) return;
    if (preview) {
      setSuggestions([]);
      return;
    }
    const query = search.trim();
    window.electronAPI.searchContacts(query).then((result) => {
      if (result.success) {
        const existing = new Set(localParticipants.map((p) => p.email));
        setSuggestions(result.contacts.filter((c) => !existing.has(c.email)));
      }
    });
  }, [search, open, localParticipants, preview]);

  const saveParticipants = useCallback(
    (updated: CalendarAttendee[]) => {
      if (preview) return;
      syncSessionExpectedCountFromParticipants(noteId, updated);
      window.electronAPI.updateNote(noteId, {
        participants: JSON.stringify(updated),
      });
    },
    [noteId, preview]
  );

  const addParticipant = useCallback(
    (email: string, displayName?: string | null) => {
      const normalized = email.toLowerCase().trim();
      if (!normalized || localParticipants.some((p) => p.email === normalized)) return;
      const updated = [
        ...localParticipants,
        { email: normalized, displayName: displayName || null, responseStatus: null, self: false },
      ];
      setLocalParticipants(updated);
      saveParticipants(updated);
      if (!preview) window.electronAPI.upsertContact({ email: normalized, displayName: displayName || null });
      setSearch("");
    },
    [localParticipants, preview, saveParticipants]
  );

  const removeParticipant = useCallback(
    (email: string) => {
      const updated = localParticipants.filter((p) => p.email !== email);
      setLocalParticipants(updated);
      saveParticipants(updated);
    },
    [localParticipants, saveParticipants]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && search.includes("@")) {
        e.preventDefault();
        addParticipant(search);
      }
    },
    [search, addParticipant]
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, CalendarAttendee[]>();
    for (const p of localParticipants) {
      const domain = p.email.split("@")[1] || "other";
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)!.push(p);
    }
    return Array.from(groups.entries());
  }, [localParticipants]);

  const chipLabel =
    localParticipants.length > 0
      ? `${localParticipants.length} ${localParticipants.length === 1 ? t("notes.participants.attendee", "attendee") : t("notes.participants.attendees", "attendees")}`
      : t("notes.participants.addAttendees", "Add attendees");

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={chipLabel}
          title={dateTitle}
          className={cn(NOTE_META_CHIP_CLASS, "pe-2")}
        >
          {dateLabel && (
            <>
              <Calendar size={14} className="shrink-0 text-muted" />
              <span>{dateLabel}</span>
              <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border dark:bg-white/15" />
            </>
          )}
          {localParticipants.length > 0 ? (
            <span className="flex items-center -space-x-1">
              {localParticipants.slice(0, MAX_STACKED_AVATARS).map((p) => (
                <PersonAvatar
                  key={p.email}
                  email={p.email}
                  displayName={p.displayName}
                  size={18}
                  className="ring-1 ring-surface-3 dark:ring-surface-2"
                />
              ))}
              {localParticipants.length > MAX_STACKED_AVATARS && (
                <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-background px-0.5 text-3xs font-medium tabular-nums text-foreground/70 ring-1 ring-surface-3 dark:bg-surface-3 dark:ring-surface-2">
                  +{localParticipants.length - MAX_STACKED_AVATARS}
                </span>
              )}
            </span>
          ) : (
            <>
              <Users size={14} className="shrink-0 text-muted" />
              {chipLabel}
            </>
          )}
          <ChevronDown size={14} className="shrink-0 text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <div className="p-2 border-b border-border/70">
          <input
            dir="auto"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("notes.participants.addPlaceholder", "Add attendees...")}
            className="w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-muted outline-none border-none appearance-none"
            autoFocus
          />
        </div>

        <div className="max-h-64 overflow-y-auto">
          {search && suggestions.length > 0 && (
            <div className="p-1 border-b border-border/70">
              {suggestions.slice(0, 5).map((contact) => (
                <button
                  key={contact.email}
                  onClick={() => addParticipant(contact.email, contact.display_name)}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-foreground/70 hover:bg-default transition-colors cursor-pointer"
                >
                  <PersonAvatar email={contact.email} displayName={contact.display_name} />
                  <span dir="auto" className="truncate">
                    {contact.display_name || contact.email}
                  </span>
                </button>
              ))}
            </div>
          )}

          {search && !search.includes("@") && suggestions.length === 0 && (
            <div className="px-3 py-2 text-2xs text-muted">
              {t("notes.participants.typeEmail", "Type an email to add...")}
            </div>
          )}

          {grouped.map(([domain, members]) => (
            <div key={domain} className="p-1">
              <div dir="ltr" className="px-2 py-1 text-2xs font-medium text-muted-foreground">
                {domain}
              </div>
              {members.map((p) => (
                <div
                  key={p.email}
                  className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-default transition-colors"
                >
                  <PersonAvatar email={p.email} displayName={p.displayName} />

                  <span dir="auto" className="flex-1 min-w-0 truncate text-xs text-foreground/70">
                    {p.displayName || p.email.split("@")[0]}
                    {p.self && (
                      <span className="ms-1 text-muted">
                        {t("notes.participants.me", "(me)")}
                      </span>
                    )}
                  </span>

                  <button
                    onClick={() => removeParticipant(p.email)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted hover:text-muted transition-opacity cursor-pointer"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ))}

          {localParticipants.length === 0 && !search && (
            <div className="px-3 py-4 text-center text-2xs text-muted">
              {t("notes.participants.typeEmail", "Type an email to add...")}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
