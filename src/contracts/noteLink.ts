// Shareable Note links: `<app protocol>://notes/<id>`. The app opens the Note
// from the link, and the Notes CLI accepts the link wherever a Note ID goes.
// The protocol selects the profile, so a link from Gristmill Dev does not read
// a production Note with the same ID.

/** Default app protocol of each channel profile; main.ts registers these. */
const NOTE_LINK_PROFILE_BY_PROTOCOL = {
  gristmill: "production",
  "gristmill-dev": "development",
  "gristmill-staging": "staging",
} as const;

type NoteLinkProtocol = keyof typeof NOTE_LINK_PROFILE_BY_PROTOCOL;

export interface ParsedNoteLink {
  protocol: string;
  noteId: number;
}

const NOTE_LINK = /^([a-z][a-z0-9+.-]*):\/\/notes\/([1-9]\d*)\/?$/i;

export function formatNoteLink(protocol: string, noteId: number): string {
  return `${protocol.toLowerCase()}://notes/${noteId}`;
}

/** Any `<protocol>://notes/<positive id>`; the caller decides which protocols it accepts. */
export function parseNoteLink(value: string): ParsedNoteLink | null {
  const match = NOTE_LINK.exec(value.trim());

  if (!match) return null;
  const noteId = Number(match[2]);

  if (!Number.isSafeInteger(noteId)) return null;

  return { protocol: match[1].toLowerCase(), noteId };
}

/** The CLI profile for a link protocol, or null for a protocol of an unknown profile. */
export function noteLinkProfile(protocol: string): string | null {
  // SAFETY: the own-key guard narrows protocol to the map's keys before the lookup.
  return Object.hasOwn(NOTE_LINK_PROFILE_BY_PROTOCOL, protocol)
    ? NOTE_LINK_PROFILE_BY_PROTOCOL[protocol as NoteLinkProtocol]
    : null;
}

/** Clipboard text for an agent: the link and how to read it. */
export function formatNoteShareText(link: string, title: string): string {
  const name = title.trim() || "Untitled";

  return (
    `Gristmill call "${name}": ${link}\n` +
    `Read it with the read-only gristmill CLI. Start with \`gristmill skills get core\`, then \`gristmill notes show ${link}\`.`
  );
}
