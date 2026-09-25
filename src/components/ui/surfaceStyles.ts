// Shared class sets that make the Radix-based primitives match HeroUI's
// fields, overlays and menu items (same tokens, radii and states).

/** Text input / textarea / select trigger. */
export const FIELD_CLASS = [
  "w-full min-w-0 rounded-lg border border-field-border bg-field px-3 text-sm text-field-foreground",
  "placeholder:text-field-placeholder outline-none transition-colors duration-150",
  "hover:border-border-hover",
  "focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/20",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:border-danger",
].join(" ");

/** Floating surface: popovers, menus, select lists, dialogs. */
export const OVERLAY_CLASS =
  "rounded-xl border border-border bg-overlay text-overlay-foreground shadow-overlay";

/** Entrance/exit motion shared by Radix floating content. */
export const OVERLAY_MOTION_CLASS =
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";

/** Selectable row inside a menu or list. */
export const MENU_ITEM_CLASS = [
  "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors",
  "hover:bg-default focus:bg-default data-highlighted:bg-default",
  "data-disabled:pointer-events-none data-disabled:opacity-50",
  "[&_svg]:shrink-0",
].join(" ");
