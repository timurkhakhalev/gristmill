/** App-level (renderer) shortcuts, distinct from the OS hotkey slots in
 * `helpers/hotkeyManager.ts`. Pure predicates so key handling can be
 * unit-tested without a DOM. Cmd on macOS, Ctrl elsewhere. */

export type AppShortcut =
  | "search"
  | "settings"
  | "new-note"
  | "new-folder"
  | "next-note"
  | "prev-note"
  | "view-notes"
  | "view-upload"
  | "shortcuts-help";

export interface ShortcutEvent {
  key: string;
  /** Physical key, layout-independent (brackets move around across layouts). */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Resolves a keydown to an app action, or null when the combo is not ours.
 * Note navigation uses Cmd+Shift+[/] (the macOS tab-switch convention) so it
 * never shadows plain Cmd+Arrow text editing. */
export function resolveAppShortcut(event: ShortcutEvent): AppShortcut | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) {
    if (key === "n") return "new-folder";
    if (event.code === "BracketRight" || key === "}" || key === "]") return "next-note";
    if (event.code === "BracketLeft" || key === "{" || key === "[") return "prev-note";
    return null;
  }
  if (key === "k") return "search";
  if (key === ",") return "settings";
  if (key === "n") return "new-note";
  if (key === "1") return "view-notes";
  if (key === "2") return "view-upload";
  if (key === "/") return "shortcuts-help";
  return null;
}

export function isCommandPaletteShortcut(event: ShortcutEvent): boolean {
  return resolveAppShortcut(event) === "search";
}
