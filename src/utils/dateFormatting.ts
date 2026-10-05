// Calendar events store all-day starts as date-only `YYYY-MM-DD` (Google's
// `start.date`). The ECMAScript parser reads that form as UTC midnight, which
// is still the previous local calendar day west of UTC, so date-only values
// must be parsed as local dates.
export type DateFormat = "locale" | "dmy" | "mdy" | "ymd";

export type TimeFormat = "locale" | "12h" | "24h";

export function formatDate(
  date: Date,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
  format: DateFormat = "locale"
): string {
  if (format === "locale") return date.toLocaleDateString(locale, options);
  const { dateStyle, ...rest } = options;

  const requested: Intl.DateTimeFormatOptions = dateStyle
    ? { year: "numeric", month: "2-digit", day: "2-digit", ...rest }
    : rest;

  const fields: Intl.DateTimeFormatOptions = {
    ...requested,
    ...(requested.month && { month: "2-digit" }),
    ...(requested.day && { day: "2-digit" }),
  };

  const parts = new Intl.DateTimeFormat(locale, fields).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;

  const order =
    format === "dmy"
      ? ["day", "month", "year"]
      : format === "mdy"
        ? ["month", "day", "year"]
        : ["year", "month", "day"];

  const ordered = order.map(value).filter((part): part is string => Boolean(part));

  if (ordered.length < 2) return new Intl.DateTimeFormat(locale, fields).format(date);
  const separator = format === "mdy" ? "/" : format === "dmy" ? "." : "-";
  const datePart = ordered.join(separator);
  const weekday = value("weekday");

  return weekday ? `${weekday}, ${datePart}` : datePart;
}

export function formatTime(
  date: Date,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
  format: TimeFormat = "locale"
): string {
  return date.toLocaleTimeString(locale, {
    ...options,
    ...(format === "locale" ? {} : { hourCycle: format === "24h" ? "h23" : "h12" }),
  });
}

export function parseEventDate(value: string): Date | null {
  if (typeof value !== "string" || !value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeDbDate(dateStr: string): Date {
  if (typeof dateStr !== "string" || !dateStr.trim()) return new Date(NaN);
  const trimmed = dateStr.trim();
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const source = hasExplicitZone ? trimmed : `${trimmed}Z`;

  return new Date(source);
}

export function formatShortDate(
  dateStr: string,
  locale?: string,
  format: DateFormat = "locale"
): string {
  if (!dateStr) return "";
  const date = normalizeDbDate(dateStr);

  if (Number.isNaN(date.getTime())) return "";

  // Locale format keeps the user-facing month name (en → "Sep 28", ru → "28 сент.").
  // The non-locale formats stay compact and dot- or slash-separated.
  if (format === "locale") {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  }

  return formatDate(date, locale, { month: "short", day: "numeric" }, format);
}

export function formatShortTime(
  dateStr: string,
  locale?: string,
  format: TimeFormat = "locale"
): string {
  if (!dateStr) return "";
  const date = normalizeDbDate(dateStr);

  if (Number.isNaN(date.getTime())) return "";

  return formatTime(date, locale, { hour: "numeric", minute: "2-digit" }, format);
}

/** Day and full month name, e.g. "28 September"; the numeric formats only choose the day/month order. */
export function formatDayMonthName(
  dateStr: string,
  locale: string | undefined,
  format: DateFormat
): string {
  if (!dateStr) return "";
  const date = normalizeDbDate(dateStr);

  if (Number.isNaN(date.getTime())) return "";
  const formatter = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" });

  if (format === "locale") return formatter.format(date);
  const parts = formatter.formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value;

  if (!day || !month) return formatter.format(date);

  return format === "dmy" ? `${day} ${month}` : `${month} ${day}`;
}

/** Date+time stamp, e.g. "28 September · 11:05". Falls back to just the date if the time is missing. */
export function formatShortDateTime(
  dateStr: string,
  locale?: string,
  dateFormat: DateFormat = "locale",
  timeFormat: TimeFormat = "locale"
): string {
  const date = formatDayMonthName(dateStr, locale, dateFormat);
  const time = formatShortTime(dateStr, locale, timeFormat);

  if (!date && !time) return "";

  if (!time) return date;

  return `${date} \u00b7 ${time}`;
}

export function formatNoteDate(
  dateStr: string,
  locale?: string,
  dateFormat: DateFormat = "locale",
  timeFormat: TimeFormat = "locale"
): string {
  const date = normalizeDbDate(dateStr);

  if (Number.isNaN(date.getTime())) return "";

  const datePart = formatDate(
    date,
    locale,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    },
    dateFormat
  );

  const timePart = formatTime(date, locale, { hour: "numeric", minute: "2-digit" }, timeFormat);

  return `${datePart} \u00b7 ${timePart}`;
}

/**
 * Compact age ("5m"), or with `ago` the chat-history form: "12s ago", "3h ago",
 * "Yesterday", then the full day and month ("28 September") for anything older.
 */
export function formatRelativeTime(
  dateStr: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  locale?: string,
  dateFormat: DateFormat = "locale",
  options: { ago?: boolean } = {}
): string {
  if (!dateStr) return "";
  const date = normalizeDbDate(dateStr);

  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();

  if (diff < 0)
    return options.ago
      ? formatDayMonthName(dateStr, locale, dateFormat)
      : formatShortDate(dateStr, locale, dateFormat);

  if (options.ago) {
    const seconds = Math.floor(diff / 1000);

    if (seconds < 60) return t("notes.list.ago.seconds", { count: seconds });

    if (seconds < 3600) return t("notes.list.ago.minutes", { count: Math.floor(seconds / 60) });
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    if (date.getTime() >= startOfToday)
      return t("notes.list.ago.hours", { count: Math.floor(seconds / 3600) });

    if (date.getTime() >= startOfToday - 86400000) return t("notes.dateGroups.yesterday");

    return formatDayMonthName(dateStr, locale, dateFormat);
  }

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t("notes.list.timeNow");

  if (minutes < 60) return t("notes.list.minutesAgo", { count: minutes });

  if (hours < 24) return t("notes.list.hoursAgo", { count: hours });

  if (days < 7) return t("notes.list.daysAgo", { count: days });

  return formatShortDate(dateStr, locale, dateFormat);
}

export function formatDateGroup(
  date: Date | string,
  t: (key: string) => string,
  locale?: string,
  format: DateFormat = "locale"
): string {
  if (!date) return "";
  const d = typeof date === "string" ? normalizeDbDate(date) : date;

  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (target.getTime() === today.getTime()) return t("notes.dateGroups.today");

  if (target.getTime() === yesterday.getTime()) return t("notes.dateGroups.yesterday");

  return formatDate(d, locale, { month: "short", day: "numeric", year: "numeric" }, format);
}
