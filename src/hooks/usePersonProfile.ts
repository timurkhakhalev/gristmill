import { useEffect, useSyncExternalStore } from "react";
import type { ContactProfile } from "../contracts/speakerProfiles";

// Shared live contact metadata, batched by stable contact ID.
const profiles = new Map<number, ContactProfile | null>();

const queued = new Set<number>();

const listeners = new Set<() => void>();

let flushScheduled = false;

let syncSubscribed = false;

const versions = new Map<number, number>();

function notify(): void {
  for (const listener of listeners) listener();
}

function flush(): void {
  flushScheduled = false;
  const ids = [...queued];
  const requested = new Map(ids.map((id) => [id, versions.get(id)]));
  queued.clear();

  if (ids.length === 0) return;

  const api = window.electronAPI;

  if (!api?.getContactProfiles) return;

  api
    .getContactProfiles(ids)
    .then((rows) => {
      for (const id of ids) if (versions.get(id) === requested.get(id)) profiles.set(id, null);

      for (const row of rows)
        if (versions.get(row.id) === requested.get(row.id)) profiles.set(row.id, row);
    })
    .catch(() => {
      for (const id of ids)
        if (versions.get(id) === requested.get(id) && !profiles.has(id)) profiles.set(id, null);
    })
    .finally(notify);
}

function request(id: number): void {
  versions.set(id, (versions.get(id) ?? 0) + 1);
  queued.add(id);

  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

function subscribeToSync(): void {
  if (syncSubscribed) return;
  syncSubscribed = true;

  const refresh = () => {
    legacyRevision++;
    legacyMentions.clear();
    notify();

    for (const id of profiles.keys()) request(id);
  };

  window.electronAPI?.onGcalEventsSynced?.(refresh);
  window.electronAPI?.onMcalEventsSynced?.(refresh);
  window.electronAPI?.onAcalEventsSynced?.(refresh);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/** Reloads one person's profile, e.g. after the user renamed them. */
export function refreshPersonProfile(profile: ContactProfile): void {
  profiles.set(profile.id, profile);
  legacyRevision++;
  legacyMentions.clear();
  notify();
  request(profile.id);
}

/** The stored profile for a contact ID; null until loaded or when nothing is known. */
export function usePersonProfile(contactId: number | null | undefined): ContactProfile | null {
  const key = contactId && Number.isSafeInteger(contactId) && contactId > 0 ? contactId : null;
  useEffect(() => {
    if (!key) return;
    subscribeToSync();

    if (!profiles.has(key)) request(key);
  }, [key]);

  return useSyncExternalStore(subscribe, () => (key ? (profiles.get(key) ?? null) : null));
}

/** "contact.example@example.com" → "Contact Example", "guest247@example.com" → "Guest247". */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] || email;
  const parts = local.split(/[._-]+/).filter(Boolean);

  if (parts.length === 0) return local;

  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/** A stored "name" that is only the mailbox (e.g. "sibfisher") says nothing the email doesn't. */
function isRealName(name: string | null | undefined, email: string): name is string {
  const candidate = name ?? "";

  return (
    Boolean(candidate) &&
    candidate.trim().toLowerCase() !== (email.split("@")[0] ?? "").toLowerCase()
  );
}

/** Prefer the current contact name, then meeting name, then the mailbox label. */
export function usePersonName(
  email: string | null,
  inviteName?: string | null,
  contactId?: number | null
): string {
  const profile = usePersonProfile(contactId);

  if (isRealName(profile?.display_name, email ?? "")) return profile.display_name;

  if (isRealName(inviteName, email ?? "")) return inviteName;

  return email ? nameFromEmail(email) : "";
}

const legacyMentions = new Map<string, number | null>();

const legacyQueued = new Set<string>();

let legacyScheduled = false;

let legacyRevision = 0;

function requestLegacyMention(email: string): void {
  legacyQueued.add(email);

  if (legacyScheduled) return;
  legacyScheduled = true;
  queueMicrotask(() => {
    legacyScheduled = false;
    const emails = [...legacyQueued];
    const revision = legacyRevision;
    legacyQueued.clear();
    window.electronAPI
      .resolveLegacyMentionContacts(emails)
      .then((rows) => {
        if (revision !== legacyRevision) return;

        for (const email of emails) legacyMentions.set(email, null);

        for (const row of rows) legacyMentions.set(row.email, row.contactId);
        notify();
      })
      .catch(() => {
        if (revision !== legacyRevision) return;

        for (const email of emails) legacyMentions.set(email, null);
        notify();
      });
  });
}

/** A view-only legacy association; snapshot matches take priority over live email. */
export function useLegacyMentionContactId(
  email: string | null,
  participants: ReadonlyArray<{ contactId: number; email: string | null }>
): number | null {
  const key = email?.trim().toLowerCase() ?? "";

  const matches = participants.filter(
    (person) => key && person.email?.trim().toLowerCase() === key
  );

  const ids = new Set(matches.map((person) => person.contactId));
  const revision = useSyncExternalStore(subscribe, () => legacyRevision);
  const loaded = useSyncExternalStore(subscribe, () => legacyMentions.has(key));
  const resolved = useSyncExternalStore(subscribe, () => legacyMentions.get(key) ?? null);
  useEffect(() => {
    if (key && matches.length === 0 && !loaded) requestLegacyMention(key);
  }, [key, matches.length, loaded, revision]);

  return matches.length ? (ids.size === 1 ? matches[0].contactId : null) : resolved;
}
