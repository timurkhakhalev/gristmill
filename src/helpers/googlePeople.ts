// Names and photos for calendar attendees from the Google People API. Calendar
// events rarely carry a display name, so the account's contacts, "other
// contacts" (people it has emailed) and Workspace directory are read in bulk
// and stored per email. Each source runs only when its scope was granted.

// Requested with the calendar scopes; any may be unchecked on the consent
// screen, so sync reads only what was granted.
export const PEOPLE_SCOPES = {
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
  otherContacts: "https://www.googleapis.com/auth/contacts.other.readonly",
  directory: "https://www.googleapis.com/auth/directory.readonly",
} as const;

/** True when a token's granted scope includes no People scope at all: reconnecting would add names and photos. */
export function lacksPeopleAccess(grantedScope: string | null | undefined): boolean {
  const granted = new Set((grantedScope ?? "").split(/\s+/));

  return !Object.values(PEOPLE_SCOPES).some((scope) => granted.has(scope));
}

const PEOPLE_API_BASE = "https://people.googleapis.com/v1";

const PAGE_SIZE = 1000;

// Other contacts default to the contact entry alone, which has only placeholder
// photos for most people (saved contacts already merge profiles); merging
// in their public Google profile adds the photo they set themselves.
const PROFILE_MERGED_SOURCES = ["READ_SOURCE_TYPE_CONTACT", "READ_SOURCE_TYPE_PROFILE"];

// Bounds a very large directory or address book to a few requests per sync.
const MAX_PAGES_PER_SOURCE = 10;

export interface GooglePersonProfile {
  email: string;
  displayName: string | null;
  photoUrl: string | null;
}

export interface PeoplePerson {
  names?: Array<{ displayName?: string; metadata?: { primary?: boolean } }>;
  emailAddresses?: Array<{ value?: string }>;
  photos?: Array<{ url?: string; default?: boolean; metadata?: { primary?: boolean } }>;
}

// The People API returns JSON envelopes; the sync reads only these fields and
// skips malformed entries, so a partial parse is the honest contract here.
export interface PeoplePage {
  nextPageToken?: string;
  connections?: PeoplePerson[];
  otherContacts?: PeoplePerson[];
  people?: PeoplePerson[];
}

// List endpoints return a page; the /people/me profile returns one person.
type ApiGet = (url: string) => Promise<PeoplePage | PeoplePerson>;

function primary<T extends { metadata?: { primary?: boolean } }>(
  items: T[] | undefined
): T | undefined {
  return items?.find((item) => item.metadata?.primary) ?? items?.[0];
}

/**
 * One profile per email of the person; a Google placeholder photo counts as none.
 * A contact merged with its Google profile can carry a placeholder contact photo
 * beside the real profile photo, so the first real photo wins.
 */
export function profilesOf(person: PeoplePerson): GooglePersonProfile[] {
  const displayName = primary(person.names)?.displayName?.trim() || null;
  const realPhotos = person.photos?.filter((photo) => photo.url && !photo.default);
  const photoUrl = primary(realPhotos)?.url ?? null;

  if (!displayName && !photoUrl) return [];

  return (person.emailAddresses ?? [])
    .map((address) => address.value?.toLowerCase().trim())
    .filter((email): email is string => Boolean(email))
    .map((email) => ({ email, displayName, photoUrl }));
}

async function collect(
  apiGet: ApiGet,
  path: string,
  params: Record<string, string | string[]>,
  itemsKey: "connections" | "otherContacts" | "people"
): Promise<PeoplePerson[]> {
  const people: PeoplePerson[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_SOURCE; page++) {
    const query = new URLSearchParams({ pageSize: String(PAGE_SIZE) });

    for (const [key, value] of Object.entries(params)) {
      for (const item of [value].flat()) query.append(key, item);
    }

    if (pageToken) query.set("pageToken", pageToken);

    // SAFETY: list endpoints return a page envelope; the union only names the
    // /people/me variant, and a malformed page yields empty lists below.
    const data = (await apiGet(`${PEOPLE_API_BASE}${path}?${query.toString()}`)) as PeoplePage;

    people.push(...(data[itemsKey] ?? []));
    pageToken = data.nextPageToken;

    if (!pageToken) break;
  }

  return people;
}

/**
 * Every profile the granted scopes can see, the account owner's included.
 * Later sources win for the same email: directory over saved contacts over
 * other contacts, the owner's own profile last.
 */
export async function fetchGooglePeople(
  apiGet: ApiGet,
  grantedScope: string,
  onSourceError: (source: string, error: Error) => void
): Promise<GooglePersonProfile[]> {
  const granted = new Set(grantedScope.split(/\s+/));
  const sources: Array<[string, () => Promise<PeoplePerson[]>]> = [];

  if (granted.has(PEOPLE_SCOPES.otherContacts)) {
    sources.push([
      "otherContacts",
      () =>
        collect(
          apiGet,
          "/otherContacts",
          { readMask: "names,emailAddresses,photos", sources: PROFILE_MERGED_SOURCES },
          "otherContacts"
        ),
    ]);
  }

  if (granted.has(PEOPLE_SCOPES.contacts)) {
    sources.push([
      "contacts",
      () =>
        collect(
          apiGet,
          "/people/me/connections",
          { personFields: "names,emailAddresses,photos" },
          "connections"
        ),
    ]);
  }

  if (granted.has(PEOPLE_SCOPES.directory)) {
    sources.push([
      "directory",
      () =>
        collect(
          apiGet,
          "/people:listDirectoryPeople",
          {
            readMask: "names,emailAddresses,photos",
            sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
          },
          "people"
        ),
    ]);
  }

  sources.push([
    "self",
    async () => {
      // SAFETY: this endpoint returns the single person profile, the other
      // union member; missing fields degrade through profilesOf.
      const me = (await apiGet(
        `${PEOPLE_API_BASE}/people/me?personFields=names,emailAddresses,photos`
      )) as PeoplePerson;

      return [me];
    },
  ]);

  const byEmail = new Map<string, GooglePersonProfile>();

  for (const [source, load] of sources) {
    try {
      for (const person of await load()) {
        for (const profile of profilesOf(person)) {
          const known = byEmail.get(profile.email);
          byEmail.set(profile.email, {
            email: profile.email,
            displayName: profile.displayName ?? known?.displayName ?? null,
            photoUrl: profile.photoUrl ?? known?.photoUrl ?? null,
          });
        }
      }
    } catch (error) {
      // A personal account has no directory; a scope can be revoked later.
      onSourceError(source, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return Array.from(byEmail.values());
}
