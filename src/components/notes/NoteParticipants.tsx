import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  AlignLeft,
  Calendar,
  Check,
  ChevronDown,
  Copy,
  Mail,
  Pencil,
  Plus,
  Send,
  Trash2,
  Users,
} from "../icons";
import { cn } from "../lib/utils";
import { NOTE_META_CHIP_CLASS } from "./shared";
import { CalendarProviderIcon, MeetingPlatformIcon } from "./meetingPlatform";
import { Popover, PopoverAnchor, PopoverTrigger, PopoverContent } from "../ui/popover";
import PersonAvatar from "../ui/PersonAvatar";
import ContactDetailsForm from "./ContactDetailsForm";
import PersonName from "../ui/PersonName";
import {
  refreshPersonProfile,
  usePersonName,
  usePersonProfile,
} from "../../hooks/usePersonProfile";
import type { CalendarEvent } from "../../contracts/calendar";
import { syncSessionExpectedCountFromParticipants } from "../../stores/meetingRecordingStore";
import { runInBackground } from "../../stores/noteStore";
import { getMeetingJoinUrl } from "../../helpers/meetingJoinUrl";
import { openExternalLink } from "../../utils/externalLinks";
import {
  formatMonthDay,
  formatTime,
  parseEventDate,
  type DateFormat,
  type TimeFormat,
} from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";
import { useUiLocale } from "../../hooks/useUiLocale";

type CalendarAttendee = {
  contactId?: number;
  email: string | null;
  displayName: string | null;
  responseStatus: "accepted" | "declined" | "needsAction" | "tentative" | null;
  self: boolean;
};

const MAX_STACKED_AVATARS = 2;

/** Local date + time range for the event; all-day events show the date only. */
function formatEventWhen(
  event: CalendarEvent,
  locale: string,
  dateFormat: DateFormat,
  timeFormat: TimeFormat
): string {
  const start = parseEventDate(event.start_time);

  if (!start) return "";

  const datePart = formatMonthDay(start, locale, dateFormat, { weekday: true });

  const end = parseEventDate(event.end_time);

  if (event.is_all_day === 1 || !end) return datePart;

  const time = (d: Date) =>
    formatTime(d, locale, { hour: "numeric", minute: "2-digit" }, timeFormat);

  const endPart =
    start.toDateString() === end.toDateString()
      ? time(end)
      : `${formatMonthDay(end, locale, dateFormat)} ${time(end)}`;

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
          <p className="pb-2 text-2xs font-medium text-muted-foreground">
            {t("notes.participants.description")}
          </p>
          <p
            dir="auto"
            className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground"
          >
            <LinkifiedText text={text} />
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Marks the hover card so the attendee list popover does not close on its clicks.
const ATTENDEE_CARD_ATTR = "data-attendee-card";

const HOVER_OPEN_DELAY_MS = 150;

const HOVER_CLOSE_DELAY_MS = 200;

const CARD_ACTION_CLASS =
  "shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-default hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/40 disabled:opacity-50";

function ContactDetails({
  attendee,
  editable,
  editing,
  onEditingChange,
  onRemove,
}: {
  attendee: CalendarAttendee;
  editable: boolean;
  editing: boolean;
  onEditingChange: (value: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const profile = usePersonProfile(attendee.contactId);
  const name = usePersonName(attendee.email, attendee.displayName, attendee.contactId);
  const email = profile ? profile.email : attendee.email;
  const telegram = profile?.telegram_username;
  const [copied, setCopied] = useState(false);

  if (editing && profile)
    return (
      <ContactDetailsForm
        contact={profile}
        displayName={name}
        onCancel={() => onEditingChange(false)}
        onSaved={async () => {
          onEditingChange(false);

          return true;
        }}
      />
    );

  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-0.5">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {name}
          {attendee.self && <span className="ms-1 text-muted">{t("notes.participants.me")}</span>}
        </p>
        {editable && (
          <button
            type="button"
            disabled={!profile}
            aria-label={t("notes.participants.editContact")}
            onClick={() => onEditingChange(true)}
            className={CARD_ACTION_CLASS}
          >
            <Pencil size={14} />
          </button>
        )}
        {email && (
          <button
            type="button"
            aria-label={t("notes.participants.copyEmail")}
            onClick={() => {
              navigator.clipboard
                .writeText(email)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
            className={CARD_ACTION_CLASS}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("notes.participants.removeAttendee", "Remove attendee")}
          className={cn(CARD_ACTION_CLASS, "hover:text-danger")}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {email && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <Mail size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{email}</span>
        </p>
      )}
      {telegram ? (
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 text-xs text-link"
          onClick={() => openExternalLink(`https://t.me/${encodeURIComponent(telegram)}`)}
        >
          <Send size={12} className="shrink-0" />
          <span className="truncate">@{telegram}</span>
        </button>
      ) : (
        editable && (
          <button
            type="button"
            disabled={!profile}
            className="flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-link"
            onClick={() => onEditingChange(true)}
          >
            <Plus size={12} className="shrink-0" />
            {t("notes.participants.addTelegram")}
          </button>
        )
      )}
    </div>
  );
}

/** Full name, email and copy action for one attendee, beside the list on hover or focus. */
function AttendeeRow({
  attendee,
  editable,
  onRemove,
}: {
  attendee: CalendarAttendee;
  editable: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const hoveredRef = useRef(false);

  const schedule = useCallback((next: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    // The card stays open while its name is being edited, wherever the pointer goes.
    timer.current = setTimeout(
      () => setOpen((current) => (next ? true : current && editingRef.current)),
      next ? HOVER_OPEN_DELAY_MS : HOVER_CLOSE_DELAY_MS
    );
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const hoverProps = {
    onMouseEnter: () => {
      hoveredRef.current = true;
      schedule(true);
    },
    onMouseLeave: () => {
      hoveredRef.current = false;
      schedule(false);
    },
  };

  // The open card tops React Aria's overlay stack but is not dismissable, so
  // while it is open a click outside closes nothing. Once a rename ends away
  // from the card, close it at once so the attendee list closes normally again.
  useEffect(() => {
    if (!editing && !hoveredRef.current) setOpen(false);
  }, [editing]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next && editing) return;
        setOpen(next);

        if (!next) setEditing(false);
      }}
    >
      <PopoverAnchor>
        <button
          type="button"
          {...hoverProps}
          onFocus={() => schedule(true)}
          onBlur={(e) => {
            if (!e.relatedTarget?.closest(`[${ATTENDEE_CARD_ATTR}]`)) schedule(false);
          }}
          onClick={() => setOpen(true)}
          className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-default focus-visible:bg-default focus-visible:ring-1 focus-visible:ring-ring/40"
        >
          <PersonAvatar
            contactId={attendee.contactId}
            email={attendee.email}
            displayName={attendee.displayName}
          />
          <span dir="auto" className="min-w-0 flex-1 truncate text-xs text-foreground/70">
            <PersonName
              contactId={attendee.contactId}
              email={attendee.email}
              inviteName={attendee.displayName}
            />
            {attendee.self && (
              <span className="ms-1 text-muted">{t("notes.participants.me", "(me)")}</span>
            )}
          </span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        focusOnOpen={false}
        className="w-80 p-0"
      >
        <div
          {...{ [ATTENDEE_CARD_ATTR]: "" }}
          {...hoverProps}
          className="flex items-start gap-3 p-4"
        >
          <PersonAvatar
            contactId={attendee.contactId}
            email={attendee.email}
            displayName={attendee.displayName}
            size={40}
          />
          <div className="min-w-0 flex-1">
            <ContactDetails
              attendee={attendee}
              editable={editable}
              editing={editing}
              onEditingChange={setEditing}
              onRemove={onRemove}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface NoteParticipantsProps {
  noteId: number;
  participants: CalendarAttendee[];
  canRenameContacts: boolean;
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
  canRenameContacts,
  event,
  dateLabel,
  dateTitle,
  preview = false,
}: NoteParticipantsProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const [localParticipants, setLocalParticipants] = useState(participants);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const activeNote = useRef(noteId);
  activeNote.current = noteId;

  const [suggestions, setSuggestions] = useState<
    Array<{ id: number; email: string | null; display_name: string | null }>
  >([]);

  const [open, setOpen] = useState(false);

  useEffect(() => {
    setLocalParticipants(participants);
  }, [participants]);

  useEffect(() => {
    setCreating(false);
    setSearch("");
    setSaveError(null);
    setSuggestions([]);
  }, [noteId]);

  useEffect(() => {
    if (!open) return;

    if (preview) {
      setSuggestions([]);

      return;
    }

    let active = true;
    setSuggestions([]);
    const query = search.trim();
    runInBackground(
      window.electronAPI.searchContacts(query).then((result) => {
        if (active && result.success) {
          const existing = new Set(localParticipants.map((p) => p.contactId));
          setSuggestions(result.contacts.filter((c) => !existing.has(c.id)));
        }
      }),
      "Contact search failed"
    );

    return () => {
      active = false;
    };
  }, [search, open, localParticipants, preview, noteId]);

  const saveParticipants = useCallback(
    async (updated: CalendarAttendee[]): Promise<boolean> => {
      if (preview || savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      const owner = noteId;

      try {
        const result = await window.electronAPI.updateNote(owner, {
          participants: JSON.stringify(updated),
        });

        if (!result.success) throw new Error("Participant save failed");

        if (activeNote.current === owner) {
          setLocalParticipants(updated);
          syncSessionExpectedCountFromParticipants(
            owner,
            updated.filter(
              (person): person is import("../../contracts/contactIdentity").NoteParticipant =>
                person.contactId !== undefined
            )
          );
        }

        return true;
      } catch {
        if (activeNote.current === owner)
          setSaveError(t("notes.participants.participantSaveFailed"));

        return false;
      } finally {
        savingRef.current = false;

        if (activeNote.current === owner) setSaving(false);
      }
    },
    [noteId, preview, t]
  );

  const addParticipant = useCallback(
    async (contact: {
      id: number;
      email: string | null;
      display_name: string | null;
    }): Promise<boolean> => {
      if (localParticipants.some((person) => person.contactId === contact.id)) {
        setSaveError(t("notes.participants.alreadyAdded"));

        return false;
      }

      const saved = await saveParticipants([
        ...localParticipants,
        {
          contactId: contact.id,
          email: contact.email,
          displayName: contact.display_name,
          responseStatus: null,
          self: false,
        },
      ]);

      if (saved && activeNote.current === noteId) {
        setSearch("");
      }

      return saved;
    },
    [localParticipants, noteId, saveParticipants, t]
  );

  const createAndAdd = useCallback(
    async (displayName: string): Promise<void> => {
      if (creating || savingRef.current) return;
      const owner = noteId;
      setCreating(true);
      setSaveError(null);

      try {
        const result = await window.electronAPI.createContact({
          displayName,
          email: null,
          telegramUsername: null,
        });

        if (!result.success) throw new Error("Contact creation failed");

        refreshPersonProfile(result.contact);
        await addParticipant(result.contact);
      } catch {
        if (activeNote.current === owner) setSaveError(t("notes.participants.contactSaveFailed"));
      } finally {
        if (activeNote.current === owner) setCreating(false);
      }
    },
    [addParticipant, creating, noteId, t]
  );

  const removeParticipant = (contactId: number | undefined) => {
    runInBackground(
      saveParticipants(localParticipants.filter((person) => person.contactId !== contactId)),
      "Participant removal failed"
    );
  };

  const grouped = useMemo(() => {
    const groups = new Map<string, CalendarAttendee[]>();

    for (const p of localParticipants) {
      const domain = p.email?.split("@")[1] || "other";

      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)?.push(p);
    }

    return Array.from(groups.entries());
  }, [localParticipants]);

  const trimmedSearch = search.trim();

  const hasExactMatch = suggestions.some(
    (contact) => contact.display_name?.trim().toLowerCase() === trimmedSearch.toLowerCase()
  );

  const joinUrl = useMemo(() => (event ? getMeetingJoinUrl(event) : null), [event]);
  const eventUrl = event?.event_url ?? null;
  const { dateFormat, timeFormat } = useDateTimePreferences();

  const when = useMemo(
    () => (event ? formatEventWhen(event, locale, dateFormat, timeFormat) : ""),
    [event, locale, dateFormat, timeFormat]
  );

  const chipLabel =
    localParticipants.length > 0
      ? `${localParticipants.length} ${localParticipants.length === 1 ? t("notes.participants.attendee", "attendee") : t("notes.participants.attendees", "attendees")}`
      : t("notes.participants.addAttendees", "Add attendees");

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!o && (creating || saving)) return;
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
                  key={p.contactId ?? p.email}
                  contactId={p.contactId}
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
      <PopoverContent
        className="w-80 p-0"
        shouldCloseOnInteractOutside={(element) => !element.closest(`[${ATTENDEE_CARD_ATTR}]`)}
      >
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
                  <button
                    type="button"
                    onClick={() => openExternalLink(eventUrl)}
                    className={EVENT_ACTION_CLASS}
                  >
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

            placeholder={t("notes.participants.addPlaceholder", "Add attendees...")}
            className="w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-muted outline-none border-none appearance-none"
            autoFocus
          />
        </div>

        <div className="max-h-64 overflow-y-auto">
          {trimmedSearch && (
            <div className="p-1 border-b border-border/70">
              {suggestions.slice(0, 5).map((contact) => (
                <button
                  key={contact.id}
                  disabled={saving}
                  onClick={() => {
                    runInBackground(addParticipant(contact), "Participant addition failed");
                  }}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-foreground/70 hover:bg-default transition-colors cursor-pointer"
                >
                  <PersonAvatar
                    contactId={contact.id}
                    email={contact.email}
                    displayName={contact.display_name}
                  />
                  <span dir="auto" className="truncate">
                    {contact.display_name || contact.email}
                  </span>
                </button>
              ))}
              {!preview && !hasExactMatch && (
                <button
                  type="button"
                  disabled={saving || creating}
                  onClick={() => {
                    runInBackground(createAndAdd(trimmedSearch), "Contact creation failed");
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs text-link transition-colors hover:bg-default disabled:opacity-50"
                >
                  <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-default">
                    <Plus size={12} />
                  </span>
                  <span dir="auto" className="truncate">
                    {t("notes.participants.createNamed", { name: trimmedSearch })}
                  </span>
                </button>
              )}
            </div>
          )}
          {saveError && (
            <p role="alert" className="px-3 py-2 text-xs text-danger">
              {saveError}
            </p>
          )}

          {grouped.map(([domain, members]) => (
            <div key={domain} className="p-1">
              <div dir="ltr" className="px-2 py-1 text-2xs font-medium text-muted-foreground">
                {domain}
              </div>
              {members.map((p) => (
                <AttendeeRow
                  key={p.contactId ?? p.email}
                  attendee={p}
                  editable={canRenameContacts && p.contactId !== undefined}
                  onRemove={() => removeParticipant(p.contactId)}
                />
              ))}
            </div>
          ))}

          {localParticipants.length === 0 && !search && (
            <div className="px-3 py-4 text-center text-2xs text-muted">
              {t("notes.participants.searchOrCreate")}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
