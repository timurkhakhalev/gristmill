/**
 * Dictionary import/export format.
 *
 * Export writes one entry per line. An entry that would otherwise be split on
 * import — it contains a comma, a double quote or a newline — is CSV-quoted and
 * `"` is escaped as `""`. Import follows the same rule: if the paste contains a
 * quote it is parsed as the quoted format; a plain paste keeps the convenient
 * comma/newline split for ordinary words.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseDictionaryImportText(text: unknown): string[] {
  const raw = String(text ?? "");
  // No quote means a plain paste (typing/pasting words); keep the historical
  // comma-and-newline split so "Acme, Inc." still pastes as two entries.
  if (!raw.includes('"')) return splitPlain(raw);
  const quoted = parseQuotedFields(raw);
  // An unbalanced quote is not the export format either; fall back rather than
  // silently swallowing the rest of the paste.
  return quoted === null ? splitPlain(raw) : normalizeFields(quoted);
}

/** Serializes entries for export, quoting those a plain split would corrupt. */
export function serializeDictionaryEntries(words: readonly string[]): string {
  return words.map(quoteField).join("\n");
}

function splitPlain(raw: string): string[] {
  return normalizeFields(raw.split(/[,\n]/));
}

function normalizeFields(fields: readonly string[]): string[] {
  return fields.map((word) => word.trim()).filter(Boolean);
}

function quoteField(word: string): string {
  if (!/[",\n\r]/.test(word)) return word;
  return `"${word.replace(/"/g, '""')}"`;
}

// Minimal CSV scan over the exported shape: comma or newline separates fields,
// a field may be quote-wrapped (after optional leading spaces), and `""` is a
// literal quote. Returns null when a quote is left open.
function parseQuotedFields(text: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  // True while the field holds only whitespace, so leading spaces before an
  // opening quote are allowed and discarded.
  let quoteMayOpen = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && quoteMayOpen) {
      inQuotes = true;
      field = "";
      quoteMayOpen = false;
      continue;
    }
    if (char === "," || char === "\n" || char === "\r") {
      fields.push(field);
      field = "";
      quoteMayOpen = true;
      continue;
    }
    field += char;
    if (char !== " " && char !== "\t") quoteMayOpen = false;
  }
  if (inQuotes) return null;
  fields.push(field);
  return fields;
}
