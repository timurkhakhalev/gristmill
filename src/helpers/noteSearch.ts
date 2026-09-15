// Builds the FTS5 MATCH expression for note search: NFC-normalized word
// tokens, quoted with doubled quotes, suffixed with the prefix operator.
export function buildNoteSearchQuery(input: unknown): string {
  if (typeof input !== "string") return "";

  const tokens = input
    .normalize("NFC")
    .match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu)
    ?.filter((token) => /[\p{L}\p{N}]/u.test(token));

  if (!tokens?.length) return "";

  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" ");
}
