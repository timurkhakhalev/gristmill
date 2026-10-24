/** Palette names a folder glyph can be tinted with; the main process validates against the same list. */
export const FOLDER_COLOR_HEX = {
  red: "#f87171",
  orange: "#fb923c",
  amber: "#fbbf24",
  green: "#4ade80",
  teal: "#2dd4bf",
  blue: "#60a5fa",
  violet: "#a78bfa",
  pink: "#f472b6",
} satisfies Record<string, string>;

export function folderColorHex(color: string): string | undefined {
  return Object.entries(FOLDER_COLOR_HEX).find(([name]) => name === color)?.[1];
}

// Custom properties are outside React.CSSProperties; the row reads them in CSS.
export function tintStyle(
  tint: string
): React.CSSProperties & { "--tint": string; "--tint-strong": string } {
  return { "--tint": `${tint}26`, "--tint-strong": `${tint}40` };
}
