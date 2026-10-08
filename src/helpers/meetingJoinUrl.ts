const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

const TRAILING_PUNCTUATION_PATTERN = /[),.;:!?]+$/;

const MEETING_URL_RULES = [
  {
    hostname: "zoom.us",
    allowSubdomains: true,
    pathnamePattern: /^\/(?:j|w|my)\/[^/]+/i,
  },
  { hostname: "meet.google.com", pathnamePattern: /^\/[^/]+/ },
  {
    hostname: "teams.microsoft.com",
    pathnamePattern: /^\/(?:l\/meetup-join|meet)\/[^/]+/i,
  },
  { hostname: "teams.live.com", pathnamePattern: /^\/meet\/[^/]+/i },
  { hostname: "webex.com", allowSubdomains: true, pathnamePattern: /^\/[^/]+/ },
  { hostname: "chime.aws", pathnamePattern: /^\/[^/]+/ },
];

/** The calendar-event surface the resolvers read; providers pass wider rows. */
export interface MeetingEventLike {
  hangout_link?: string | null;
  conference_data?: string | null;
}

interface MeetingUrlRule {
  hostname: string;
  allowSubdomains?: boolean;
  pathnamePattern: RegExp;
}

function isAllowedHostname(
  candidateHostname: string,
  allowedHostname: string,
  allowSubdomains?: boolean
): boolean {
  return (
    candidateHostname === allowedHostname ||
    (allowSubdomains === true && candidateHostname.endsWith(`.${allowedHostname}`))
  );
}

function isMeetingUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return MEETING_URL_RULES.some(
      ({ hostname, allowSubdomains, pathnamePattern }: MeetingUrlRule) =>
        isAllowedHostname(url.hostname, hostname, allowSubdomains) &&
        pathnamePattern.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function getMeetingJoinUrl(event: MeetingEventLike | null | undefined): string | null {
  if (!event) return null;
  const hangoutLink = event.hangout_link?.trim();

  if (hangoutLink) return hangoutLink;

  if (!event.conference_data) return null;

  try {
    const data: unknown = JSON.parse(event.conference_data);

    const uri = readVideoEntryPoint(data);

    return uri || null;
  } catch {
    return null;
  }
}

interface ConferenceEntryPoints {
  entryPoints?: Array<{ entryPointType?: string; uri?: string | null }>;
}

function readVideoEntryPoint(decoded: unknown): string | null {
  // Google conference_data JSON: only the optional entryPoints list is read;
  // anything else has no video URI.
  // SAFETY: decoded Google conference_data JSON; every field access below is
  // guarded before use.
  const data = decoded as ConferenceEntryPoints;

  if (!Array.isArray(data?.entryPoints)) return null;

  const uri = data.entryPoints
    .find((ep) => ep.entryPointType === "video" && ep.uri?.trim())
    ?.uri?.trim();

  return uri || null;
}

// Finds a meeting link in loose text (EventKit has no structured conference
// data — Zoom/Meet/Teams/Webex links live in url, location, or notes). Sources
// are calendar-manager fields typed loosely; only usable strings participate.
export function extractMeetingUrl(candidates: string[]): string | null {
  for (const candidate of candidates) {
    for (const match of candidate.matchAll(URL_PATTERN)) {
      const value = match[0].replace(TRAILING_PUNCTUATION_PATTERN, "");

      if (isMeetingUrl(value)) return value;
    }
  }

  return null;
}
