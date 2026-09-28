import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlignLeft, Calendar, Check, ChevronDown, Copy, Trash2, Users } from "../icons";
import { cn } from "../lib/utils";
import { NOTE_META_CHIP_CLASS } from "./shared";
import { CalendarProviderIcon, MeetingPlatformIcon } from "./meetingPlatform";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import PersonAvatar from "../ui/PersonAvatar";
import PersonName from "../ui/PersonName";
import type { CalendarAttendee, CalendarEvent } from "../../contracts/calendar";
import { syncSessionExpectedCountFromParticipants } from "../../stores/meetingRecordingStore";
import { getMeetingJoinUrl } from "../../helpers/meetingJoinUrl";
import { openExternalLink } from "../../utils/externalLinks";
import { formatDate, formatTime, parseEventDate, type DateFormat, type TimeFormat } from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";
import { useUiLocale } from "../../hooks/useUiLocale";

const MAX_STACKED_AVATARS = 2;

/** Local date + time range for the event; all-day events show the date only. */
function formatEventWhen(event: CalendarEvent, locale: string, dateFormat: DateFormat, timeFormat: TimeFormat): string {
  const start = parseEventDate(event.start_time);
  if (!start) return "";
  const datePart = formatDate(start, locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }, dateFormat);
  const end = parseEventDate(event.end_time);
  if (event.is_all_day === 1 || !end) return datePart;
  const time = (d: Date) => formatTime(d, locale, { hour: "numeric", minute: "2-digit" }, timeFormat);
  const endPart =
    start.toDateString() === end.toDateString()
      ? time(end)
      : `${formatDate(end, locale, { month: "short", day: "numeric" }, dateFormat)} ${time(end)}`;
  return `${datePart} · ${time(start)} – ${endPart}`;
}

const EVENT_ACTION_CLASS =
  "flex min-w-0 flex-1 items-center justify-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-default focus-visible:ring-1 focus-visible:ring-ring/40";

const URL_PATTERN = /(https?:\/\/[^\s)]+)/g;

/** Description text with its links made clickable. */
function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_PATTERN).map((part, index) =>
        index % 2 === 1 ? (
          <button
            key={index}
            type="button"
            onClick={() => openExternalLink(part)}
            className="break-all text-start text-link underline-offset-2 hover:underline"
          >
            {part}
          </button>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  );
}

/** Two-line preview of the event description; the full text opens beside the card. */
function EventDescription({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("notes.participants.description")}
          className="mt-2 flex w-full items-start gap-2 rounded-lg bg-default/60 px-2.5 py-2 text-start transition-colors hover:bg-default focus-visible:ring-1 focus-visible:ring-ring/40"
        >
          <AlignLeft size={14} className="mt-0.5 shrink-0 text-muted" />
          <span dir="auto" className="line-clamp-2 min-w-0 flex-1 text-xs text-muted-foreground">
            {text}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-80 p-0">
        <div className="max-h-96 overflow-y-auto p-3">
          <p className="pb-2 text-2xs font-medium text-muted-foreground">{t("notes.participants.description")}</p>
          <p dir="auto" className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
            <LinkifiedText text={text} />
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Full name, email and copy action for one attendee, opened on click or focus. */
function AttendeeCard({
  attendee,
  onRemove,
}: {
  attendee: CalendarAttendee;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copyEmail = useCallback(() => {
    navigator.clipboard
      .writeText(attendee.email)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [attendee.email]);

  return (
    <PopoverContent className="w-64 p-3">
      <div className="flex items-center gap-2.5">
        <PersonAvatar
          email={attendee.email}
          displayName={attendee.displayName}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <p dir="auto" className="truncate text-sm font-medium text-foreground">
            <PersonName email={attendee.email} inviteName={attendee.displayName} />
            {attendee.self && (
              <span className="ms-1 font-normal text-muted">{t("notes.participants.me", "(me)")}</span>
            )}
          </p>
          <div className="mt-0.5 flex items-center gap-1">
            <span dir="ltr" className="min-w-0 flex-1 truncate text-xs text-muted">
              {attendee.email}
            </span>
            <button
              type="button"
              onClick={copyEmail}
              aria-label={copied ? t("notes.participants.emailCopied", "Email copied") : t("notes.participants.copyEmail", "Copy email")}
              className="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/40"
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("notes.participants.removeAttendee", "Remove attendee")}
          className="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/40"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </PopoverContent>
  );
}

interface NoteParticipantsProps {
  noteId: number;
  participants: CalendarAttendee[];
  /** The linked calendar event; when absent the card shows only participants. */
  event?: CalendarEvent | null;
  /** When present the capsule leads with the note's date, so date and people read as one fact. */
  dateLabel?: string;
  dateTitle?: string;
  preview?: boolean;
}

export default function NoteParticipants({
  noteId,
  participants,
  event,
  dateLabel,
  dateTitle,
  preview = false,
}: NoteParticipantsProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
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

  const joinUrl = useMemo(() => (event ? getMeetingJoinUrl(event) : null), [event]);
  const eventUrl = event?.event_url ?? null;
  const { dateFormat, timeFormat } = useDateTimePreferences();
  const when = useMemo(() => (event ? formatEventWhen(event, locale, dateFormat, timeFormat) : ""), [event, locale, dateFormat, timeFormat]);

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
      <PopoverContent className="w-80 p-0">
        {event && (
          <div className="border-b border-border/70 p-3">
            <p dir="auto" className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
              {event.summary || t("upcoming.untitledEvent", "Untitled Event")}
            </p>
            {when && <p className="mt-0.5 text-xs tabular-nums text-muted">{when}</p>}
            {event.description && <EventDescription text={event.description} />}
            {(joinUrl || eventUrl) && (
              <div className="mt-2 flex gap-2">
                {joinUrl && (
                  <button
                    type="button"
                    onClick={() => openExternalLink(joinUrl)}
                    title={joinUrl}
                    className={EVENT_ACTION_CLASS}
                  >
                    <MeetingPlatformIcon url={joinUrl} />
                    {t("notes.participants.join")}
                  </button>
                )}
                {eventUrl && (
                  <button type="button" onClick={() => openExternalLink(eventUrl)} className={EVENT_ACTION_CLASS}>
                    <CalendarProviderIcon provider={event.provider} />
                    {t("notes.participants.calendar")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

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
                <Popover key={p.email}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-default focus-visible:bg-default focus-visible:ring-1 focus-visible:ring-ring/40"
                    >
                      <PersonAvatar email={p.email} displayName={p.displayName} />
                      <span dir="auto" className="min-w-0 flex-1 truncate text-xs text-foreground/70">
                        <PersonName email={p.email} inviteName={p.displayName} />
                        {p.self && (
                          <span className="ms-1 text-muted">{t("notes.participants.me", "(me)")}</span>
                        )}
                      </span>
                    </button>
                  </PopoverTrigger>
                  <AttendeeCard attendee={p} onRemove={() => removeParticipant(p.email)} />
                </Popover>
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
