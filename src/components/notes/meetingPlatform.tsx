import type { ReactNode } from "react";
import { Video } from "../icons";
import googleCalendarIcon from "../../assets/icons/google-calendar.svg";
import microsoftCalendarIcon from "../../assets/icons/microsoft-calendar.svg";
import appleCalendarIcon from "../../assets/icons/apple-calendar.svg";

// Join-link icon classification includes services without recording evidence support.
type MeetingLinkPlatform = "zoom" | "meet" | "teams" | "webex" | "other";

function meetingPlatformOf(url: string): MeetingLinkPlatform {
  let host = "";

  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }

  if (host === "zoom.us" || host.endsWith(".zoom.us")) return "zoom";

  if (host === "meet.google.com") return "meet";

  if (host.endsWith("teams.microsoft.com") || host.endsWith("teams.live.com")) return "teams";

  if (host.endsWith("webex.com")) return "webex";

  return "other";
}

function ZoomIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#0B5CFF" />
      <path
        d="M5 8.6c0-.6.5-1.1 1.1-1.1h6.6c1.2 0 2.2 1 2.2 2.2v4.8c0 .6-.5 1.1-1.1 1.1H7.2c-1.2 0-2.2-1-2.2-2.2V8.6Z"
        fill="#fff"
      />
      <path d="m15.6 10.6 2.7-2c.3-.2.7 0 .7.4v6c0 .4-.4.6-.7.4l-2.7-2v-2.8Z" fill="#fff" />
    </svg>
  );
}

function MeetIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 8.5 7 5h7.5c.8 0 1.5.7 1.5 1.5V9l4-3.2c.4-.3 1 0 1 .5v11.4c0 .5-.6.8-1 .5L16 15v2.5c0 .8-.7 1.5-1.5 1.5H4.5C3.7 19 3 18.3 3 17.5v-9Z"
        fill="#00AC47"
      />
      <path d="M3 8.5h4V5L3 8.5Z" fill="#EA4335" />
      <path d="M3 8.5h4V15H3V8.5Z" fill="#2684FC" />
      <path d="M3 15h4v4H4.5C3.7 19 3 18.3 3 17.5V15Z" fill="#0066DA" />
      <path d="M7 5h7.5c.8 0 1.5.7 1.5 1.5V9l-4 3-5-3.5V5Z" fill="#FFBA00" />
      <path d="M16 15v2.5c0 .8-.7 1.5-1.5 1.5H7v-4h9Z" fill="#00832D" />
    </svg>
  );
}

function TeamsIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="17.5" cy="6.5" r="2.5" fill="#7B83EB" />
      <rect x="14" y="10" width="8" height="8" rx="2.5" fill="#7B83EB" />
      <circle cx="11" cy="5.5" r="3" fill="#5059C9" />
      <rect x="6" y="9.5" width="11" height="10.5" rx="3" fill="#5059C9" />
      <rect x="2" y="7" width="11" height="11" rx="2" fill="#4B53BC" />
      <path d="M5 10h5v1.4H8.2V15H6.8v-3.6H5V10Z" fill="#fff" />
    </svg>
  );
}

function WebexIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#07C160" />
      <path
        d="M6.5 9.5 8.5 15l1.8-4.2L12 15l2-5.5M15.5 9.5v5.5h2.5"
        stroke="#fff"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The meeting app's mark for a join link; a camera for links it does not recognise. */
export function MeetingPlatformIcon({ url, size = 16 }: { url: string; size?: number }): ReactNode {
  switch (meetingPlatformOf(url)) {
    case "zoom":
      return <ZoomIcon size={size} />;
    case "meet":
      return <MeetIcon size={size} />;
    case "teams":
      return <TeamsIcon size={size} />;
    case "webex":
      return <WebexIcon size={size} />;
    default:
      return <Video size={size} className="text-muted" />;
  }
}

const CALENDAR_ICONS = {
  google: googleCalendarIcon,
  microsoft: microsoftCalendarIcon,
  apple: appleCalendarIcon,
} satisfies Record<string, string>;

/** The calendar app's mark for an event's provider. */
export function CalendarProviderIcon({
  provider,
  size = 16,
}: {
  provider: string;
  size?: number;
}): ReactNode {
  // SAFETY: the `in` check above proved the provider is one of the three known keys.
  const src =
    provider in CALENDAR_ICONS
      ? CALENDAR_ICONS[provider as keyof typeof CALENDAR_ICONS]
      : undefined;

  return src ? <img src={src} alt="" width={size} height={size} className="shrink-0" /> : null;
}
