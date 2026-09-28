// Calendar providers hand event descriptions over as HTML (Google) or plain
// text (Microsoft's bodyPreview). The app shows them as plain text, so HTML is
// flattened here, once, at sync time.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Plain text of an event description; null when nothing readable is left. */
export function calendarDescriptionText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = decodeEntities(
    raw
      // A link keeps its target when its text is something else, e.g. "Join".
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, (_match, href: string, label: string) => {
        const plainLabel = label.replace(/<[^>]+>/g, "").trim();
        return plainLabel && plainLabel !== href ? `${plainLabel} (${href})` : href;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}
