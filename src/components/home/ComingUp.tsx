import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, ExternalLink, Loader2, Mic, Monitor, Video } from "../icons";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import PersonAvatar from "../ui/PersonAvatar";
import PersonName from "../ui/PersonName";
import EmptyStateCard from "../ui/EmptyStateCard";
import { cn } from "../lib/utils";
import type { CalendarAttendee, CalendarEvent } from "../../contracts/calendar";
import { parseAttendees } from "../../utils/calendarAttendees";
import { useSystemAudioPermission } from "../../hooks/useSystemAudioPermission";
import { useUiLocale } from "../../hooks/useUiLocale";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import { getMeetingJoinUrl } from "../../helpers/meetingJoinUrl";
import { formatTime, parseEventDate, type TimeFormat } from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";

interface ComingUpProps {
  events: CalendarEvent[];
  isLoading: boolean;
  isConnected: boolean;
  onConnectCalendar: () => void;
  /** Opens the event's note (existing or new and empty) without starting a recording. */
  onOpenEvent: (event: CalendarEvent) => void;
}

const openJoinUrl = (url: string) => {
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, "_blank");
  }
};

function formatTimeRange(locale: string, startTime: string, endTime: string, timeFormat: TimeFormat): string {
  const format = (value: string) =>
    formatTime(new Date(value), locale, { hour: "numeric", minute: "2-digit" }, timeFormat);
  return `${format(startTime)} – ${format(endTime)}`;
}

// Today plus the next days that have events, capped at a working week.
const MAX_DAYS = 5;
// Avatars shown before the "+N" overflow pill.
const MAX_STACKED_AVATARS = 2;

interface DayGroup {
  key: string;
  date: Date;
  isToday: boolean;
  items: CalendarEvent[];
}

function groupEventsByDay(events: CalendarEvent[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();
  for (const event of events) {
    const date = parseEventDate(event.start_time);
    if (!date) continue;
    const key = date.toDateString();
    let group = byKey.get(key);
    if (!group) {
      group = { key, date, isToday: key === now.toDateString(), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(event);
  }
  // Surface "today" even when it has nothing scheduled, so the list always
  // answers "what's next today?" at a glance.
  if (!groups.some((g) => g.isToday)) {
    groups.unshift({ key: now.toDateString(), date: now, isToday: true, items: [] });
  }
  return groups.slice(0, MAX_DAYS);
}

const ATTENDEE_COUNT_PILL_CLASS =
  "flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-surface-3 px-0.5 text-3xs font-medium tabular-nums text-muted-foreground ring-1 ring-surface-2";

const RSVP_DOT: Record<string, string> = {
  accepted: "bg-success",
  declined: "bg-danger",
  tentative: "bg-warning",
};

function AttendeePopover({
  event,
  attendees,
  timeRange,
  joinUrl,
}: {
  event: CalendarEvent;
  attendees: CalendarAttendee[];
  timeRange: string;
  joinUrl: string | null;
}) {
  const { t } = useTranslation();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={`${attendees.length} ${t("notes.participants.attendees")}`}
          className="flex shrink-0 items-center -space-x-1 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-focus"
        >
          {attendees.slice(0, MAX_STACKED_AVATARS).map((a) => (
            <PersonAvatar
              key={a.email}
              email={a.email}
              displayName={a.displayName}
              size={18}
              className="ring-1 ring-surface-2"
            />
          ))}
          {attendees.length > MAX_STACKED_AVATARS && (
            <span className={ATTENDEE_COUNT_PILL_CLASS}>
              +{attendees.length - MAX_STACKED_AVATARS}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-border/70 px-3 py-2.5">
          <p dir="auto" className="text-xs font-medium leading-snug text-foreground">
            {event.summary || t("upcoming.untitledEvent")}
          </p>
          <p className="mt-0.5 text-2xs tabular-nums text-muted-foreground">{timeRange}</p>
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {attendees.map((a) => (
            <div key={a.email} className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <PersonAvatar email={a.email} displayName={a.displayName} />
              <div className="min-w-0 flex-1">
                <p dir="auto" className="truncate text-xs text-foreground/80">
                  <PersonName email={a.email} inviteName={a.displayName} />
                  {a.self && (
                    <span className="ms-1 text-muted">{t("notes.participants.me")}</span>
                  )}
                </p>
                <p dir="ltr" className="truncate text-2xs text-muted">
                  {a.email}
                </p>
              </div>
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  RSVP_DOT[a.responseStatus ?? ""] ?? "bg-muted-foreground/25"
                )}
              />
            </div>
          ))}
        </div>
        {joinUrl && (
          <div className="border-t border-border/70 p-1">
            <button
              onClick={() => openJoinUrl(joinUrl)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground/70 transition-colors hover:bg-default"
            >
              <ExternalLink size={12} className="shrink-0" />
              {t("upcoming.openMeetingLink")}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function EventRow({ event, isNow, onOpen }: { event: CalendarEvent; isNow: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const { timeFormat } = useDateTimePreferences();
  const joinUrl = getMeetingJoinUrl(event);
  const attendees = useMemo(() => parseAttendees(event), [event]);
  const timeRange = formatTimeRange(locale, event.start_time, event.end_time, timeFormat);

  const startNotes = () => {
    if (joinUrl) openJoinUrl(joinUrl);
    window.electronAPI?.joinCalendarMeeting?.(event.id);
  };

  const joinButton = (
    <Button
      size="sm"
      variant="ghost"
      onClick={startNotes}
      className="h-7 shrink-0 gap-1.5 rounded-full bg-surface-3 px-3 text-xs text-foreground hover:bg-surface-raised"
    >
      {joinUrl ? <Video size={12} /> : <Mic size={12} />}
      {joinUrl ? t("upcoming.joinAndTranscribe") : t("upcoming.takeNotes")}
    </Button>
  );

  const attendeeStack =
    attendees.length > 1 ? (
      <AttendeePopover event={event} attendees={attendees} timeRange={timeRange} joinUrl={joinUrl} />
    ) : event.attendees_count > 1 ? (
      <span className={ATTENDEE_COUNT_PILL_CLASS}>+{event.attendees_count - 1}</span>
    ) : null;

  return (
    // The row is a plate that lights up on hover, like a list item; the whole plate opens
    // the event's note, and the avatars and join button sit above that click target.
    <div className="group/event relative -mx-2 flex items-stretch gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-default/70 has-[>button:focus-visible]:bg-default/70">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("upcoming.openEventNote", { title: event.summary || t("upcoming.untitledEvent") })}
        className="absolute inset-0 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />
      <span
        aria-hidden="true"
        className={cn("pointer-events-none relative w-0.5 shrink-0 rounded-full", isNow ? "bg-success" : "bg-primary/70")}
      />
      <div className="pointer-events-none relative min-w-0 flex-1 py-0.5">
        <p dir="auto" className="truncate text-sm font-medium leading-snug text-foreground">
          {event.summary || t("upcoming.untitledEvent")}
        </p>
        {isNow ? (
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            <span className="text-xs font-medium text-success">{t("upcoming.now")}</span>
          </span>
        ) : (
          <p className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">{timeRange}</p>
        )}
      </div>
      {isNow ? (
        // A live meeting keeps both: who is in it and a way in.
        <div className="relative flex shrink-0 items-center gap-3">
          {attendeeStack}
          {joinButton}
        </div>
      ) : (
        // Hovering swaps the avatars for the join button in the same slot.
        <div className="relative grid shrink-0 items-center justify-items-end">
          <div className="col-start-1 row-start-1 transition-opacity duration-150 group-hover/event:pointer-events-none group-hover/event:opacity-0 group-has-[:focus-visible]/event:opacity-0">
            {attendeeStack}
          </div>
          <div className="pointer-events-none col-start-1 row-start-1 opacity-0 transition-opacity duration-150 group-hover/event:pointer-events-auto group-hover/event:opacity-100 group-has-[:focus-visible]/event:pointer-events-auto group-has-[:focus-visible]/event:opacity-100">
            {joinButton}
          </div>
        </div>
      )}
    </div>
  );
}

function DayRow({
  group,
  isNowFn,
  onOpenEvent,
}: {
  group: DayGroup;
  isNowFn: (e: CalendarEvent) => boolean;
  onOpenEvent: (event: CalendarEvent) => void;
}) {
  const { t } = useTranslation();
  const locale = useUiLocale();

  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-4 px-5 py-4">
      <div className="flex items-center gap-2.5">
        <span className="w-9 text-3xl font-light leading-none tracking-tight tabular-nums text-foreground">
          {group.date.getDate()}
        </span>
        <div className="min-w-0 leading-tight">
          <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <span className="truncate">
              {group.date.toLocaleDateString(locale, { month: "long" })}
            </span>
            {group.isToday && (
              <span
                aria-label={t("home.today")}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
              />
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {group.date.toLocaleDateString(locale, { weekday: "short" })}
          </p>
        </div>
      </div>
      {group.items.length === 0 ? (
        <div className="flex items-stretch gap-3 self-center">
          <span aria-hidden="true" className="w-0.5 shrink-0 rounded-full bg-border" />
          <p className="py-2 text-sm text-muted-foreground">{t("upcoming.noEventsToday")}</p>
        </div>
      ) : (
        <div className="space-y-1">
          {group.items.map((event) => (
            <EventRow key={event.id} event={event} isNow={isNowFn(event)} onOpen={() => onOpenEvent(event)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Home's calendar block: today plus the next days with meetings, one row per day. */
export default function ComingUp({
  events,
  isLoading,
  isConnected,
  onConnectCalendar,
  onOpenEvent,
}: ComingUpProps) {
  const { t } = useTranslation();
  const systemAudio = useSystemAudioPermission();
  const needsSystemAudioGrant = !systemAudio.granted && canManageSystemAudioInApp(systemAudio);

  const now = useMemo(() => new Date(), []);
  const groupedEvents = useMemo(() => groupEventsByDay(events, now), [events, now]);

  const isNowFn = (event: CalendarEvent) => {
    const start = new Date(event.start_time);
    const end = new Date(event.end_time);
    return start <= now && now <= end;
  };

  return (
    <section>
      <h2 className="pb-4 text-2xl text-foreground">{t("upcoming.title")}</h2>

      {isLoading && events.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-6">
          <Loader2 size={14} className="animate-spin text-primary" />
        </div>
      )}

      {!isLoading && !isConnected && (
        <EmptyStateCard
          className="px-4 py-8"
          icon={Calendar}
          title={t("upcoming.connectCalendar")}
          description={t("upcoming.connectCalendarDescription")}
        >
          <Button
            size="sm"
            onClick={onConnectCalendar}
            className="h-[30px] rounded-full px-3.5 text-xs"
          >
            {t("upcoming.connectCalendarButton")}
          </Button>
        </EmptyStateCard>
      )}

      {isConnected && (!isLoading || events.length > 0) && (
        <>
          <div className="divide-y divide-dashed divide-border overflow-clip rounded-2xl border border-border bg-surface-2">
            {groupedEvents.map((group) => (
              <DayRow key={group.key} group={group} isNowFn={isNowFn} onOpenEvent={onOpenEvent} />
            ))}
          </div>
          {events.length === 0 &&
            (needsSystemAudioGrant ? (
              <div className="mt-2 flex items-center gap-2 px-1 text-xs text-muted-foreground">
                <Monitor size={12} className="shrink-0" />
                <span className="flex-1">{t("upcoming.systemAudioRequired")}</span>
                <button
                  onClick={() => systemAudio.request()}
                  className="cursor-pointer text-primary underline-offset-2 outline-none hover:underline focus-visible:underline"
                >
                  {systemAudio.mode === "native"
                    ? t("upcoming.openSettings")
                    : t("onboarding.permissions.grantAccess")}
                </button>
              </div>
            ) : (
              <p className="mt-2 px-1 text-xs text-muted-foreground">
                {t("upcoming.moreCalendarsHint")}{" "}
                <button
                  onClick={onConnectCalendar}
                  className="cursor-pointer text-primary underline-offset-2 outline-none hover:underline focus-visible:underline"
                >
                  {t("upcoming.connectHere")}
                </button>
              </p>
            ))}
        </>
      )}
    </section>
  );
}
