import { useEffect, useSyncExternalStore } from "react";
import type { ContactProfile } from "../contracts/speakerProfiles";

// Names and photos per email (Google People first, then calendar or typed
// names), shared by every avatar and name on screen. Lookups are batched into
// one IPC call per tick and refreshed whenever a calendar sync lands, which is
// also when new People data is stored.

const profiles = new Map<string, ContactProfile | null>();
const queued = new Set<string>();
const listeners = new Set<() => void>();
let flushScheduled = false;
let syncSubscribed = false;

const keyOf = (email: string) => email.toLowerCase().trim();

function notify(): void {
  for (const listener of listeners) listener();
}

function flush(): void {
  flushScheduled = false;
  const emails = [...queued];
  queued.clear();
  if (emails.length === 0) return;
  const lookup = window.electronAPI?.getContactProfiles;
  if (!lookup) return;
  void lookup(emails)
    .then((rows) => {
      for (const email of emails) profiles.set(email, null);
      for (const row of rows) profiles.set(keyOf(row.email), row);
    })
    .catch(() => {
      for (const email of emails) profiles.set(email, null);
    })
    .finally(notify);
}

function request(email: string): void {
  queued.add(email);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

function subscribeToSync(): void {
  if (syncSubscribed) return;
  syncSubscribed = true;
  window.electronAPI?.onGcalEventsSynced?.(() => {
    for (const email of profiles.keys()) request(email);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The stored profile for an email; null until loaded or when nothing is known. */
export function usePersonProfile(email: string | null | undefined): ContactProfile | null {
  const key = email ? keyOf(email) : "";
  useEffect(() => {
    if (!key) return;
    subscribeToSync();
    if (!profiles.has(key)) request(key);
  }, [key]);
  return useSyncExternalStore(subscribe, () => (key ? (profiles.get(key) ?? null) : null));
}

/** "eli.rum@example.com" → "Eli Rum", "vladitex247@example.com" → "Vladitex247". */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] || email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return local;
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/** A stored "name" that is only the mailbox (e.g. "sibfisher") says nothing the email doesn't. */
function isRealName(name: string | null | undefined, email: string): name is string {
  return Boolean(name) && name!.trim().toLowerCase() !== (email.split("@")[0] ?? "").toLowerCase();
}

/** The name to show for a person: Google People, then the invite's name, then one read from the email. */
export function usePersonName(email: string, inviteName?: string | null): string {
  const profile = usePersonProfile(email);
  if (isRealName(profile?.display_name, email)) return profile.display_name;
  if (isRealName(inviteName, email)) return inviteName;
  return nameFromEmail(email);
}
