import {
  BookOpen,
  Search,
  ClipboardCheck,
  Calendar,
  CalendarCheck,
  FileText,
  FilePlus,
  FilePen,
  Zap,
} from "../icons";

// `satisfies` keeps each entry's exact component type while enforcing that
// every value is a Search-compatible icon, so a missing name is still a
// compile error (the index signature would have hidden it).
const ICONS = {
  search_notes: Search,
  copy_to_clipboard: ClipboardCheck,
  get_calendar_events: Calendar,
  get_calendar_availability: CalendarCheck,
  get_note: FileText,
  create_note: FilePlus,
  update_note: FilePen,
  get_snippet: Zap,
  update_snippets: Zap,
  update_dictionary: BookOpen,
} satisfies Record<string, typeof Search>;

export type ToolIcon = typeof Search;

export type ToolName = keyof typeof ICONS;

/** Whether a tool name has a dedicated icon in this build. */
export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(ICONS, name);
}

export const toolIcons = ICONS;
