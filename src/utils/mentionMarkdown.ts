import { z } from "zod";

export interface MentionPerson {
  name: string;
  email: string | null;
  contactId: number | null;
}

export const MENTION_HREF_PREFIX = "mention:";

// Mention attributes come from the editor's node JSON; malformed values fall back.
export const mentionAttrsSchema = z.object({
  label: z.string().catch(""),
  email: z.string().nullable().catch(null),
  contactId: z.number().int().positive().nullable().catch(null),
  href: z.string().nullable().catch(null),
});

const sanitizeLabel = (name: string) =>
  name
    .replace(/[[\]\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** New links use contact IDs; unbound names stay plain text. */
export function buildMentionMarkdown(person: MentionPerson): string {
  const label = sanitizeLabel(person.name);
  const id = z.number().int().positive().safeParse(person.contactId);

  return id.success ? `[@${label}](mention:contact:${id.data})` : `@${label}`;
}

export function parseMentionContactId(href: string | null): number | null {
  const match = href?.match(/^mention:contact:([1-9][0-9]*)$/);

  const parsed = z
    .number()
    .int()
    .positive()
    .safeParse(match ? Number(match[1]) : null);

  return parsed.success ? parsed.data : null;
}

export function parseMentionEmail(href: string | null): string | null {
  if (!href?.startsWith(MENTION_HREF_PREFIX)) return null;

  try {
    const id = decodeURIComponent(href.slice(MENTION_HREF_PREFIX.length));

    const parsed = z.string().email().safeParse(id.trim().toLowerCase());

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const TASK_OWNER_LINE = /^(\s*[-*]\s*\[[ xX]\]\s+\S.*?)(\s+[—–-]\s+)(\S.*?)\s*$/;

const OWNER_SPLIT = /\s*(?:,|&|\/|\band\b)\s*/i;

interface NameIndex {
  byFullName: Map<string, MentionPerson | null>;
  byFirstName: Map<string, MentionPerson | null>;
}

function buildNameIndex(people: MentionPerson[]): NameIndex {
  const byFullName = new Map<string, MentionPerson | null>();

  for (const person of people) {
    const name = sanitizeLabel(person.name).toLowerCase();

    if (name) byFullName.set(name, byFullName.has(name) ? null : person);
  }

  // First names resolve only when unambiguous across all known people.
  const byFirstName = new Map<string, MentionPerson | null>();

  for (const [fullName, person] of byFullName) {
    const first = fullName.split(" ")[0];
    byFirstName.set(first, byFirstName.has(first) ? null : person);
  }

  return { byFullName, byFirstName };
}

function matchOwner(raw: string, index: NameIndex): MentionPerson | null {
  const owner = raw.trim().replace(/^@/, "").replace(/[.:]$/, "").toLowerCase();

  if (!owner) return null;

  const person = index.byFullName.has(owner)
    ? index.byFullName.get(owner)
    : index.byFirstName.get(owner);

  return person?.contactId ? person : null;
}

/**
 * Converts the trailing owner of `- [ ] Action — Owner` checkbox lines into
 * mention links when the owner matches a known person, so generated action
 * items render as tagged owner chips in the editor. Lines with unknown or
 * ambiguous owners are left untouched.
 */
export function tagActionItemOwners(markdown: string, people: MentionPerson[]): string {
  if (!markdown || people.length === 0) return markdown;
  const index = buildNameIndex(people);

  if (index.byFullName.size === 0) return markdown;

  return markdown
    .split("\n")
    .map((line) => {
      if (line.includes(MENTION_HREF_PREFIX)) return line;
      const match = line.match(TASK_OWNER_LINE);

      if (!match) return line;
      const [, task, separator, ownerText] = match;
      const parts = ownerText.split(OWNER_SPLIT).filter(Boolean);

      if (parts.length === 0) return line;
      const owners = parts.map((part) => matchOwner(part, index));
      const people = owners.filter((owner): owner is MentionPerson => owner != null);

      if (people.length !== owners.length) return line;

      return `${task}${separator}${people.map((owner) => buildMentionMarkdown(owner)).join(", ")}`;
    })
    .join("\n");
}
