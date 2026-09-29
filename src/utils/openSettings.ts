const OPEN_SETTINGS_EVENT = "gristmill:open-settings";

/** Opens the Settings modal (optionally on a section) from anywhere in the control panel. */
export function openSettings(section?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section } }));
}

export function onOpenSettingsRequest(handler: (section?: string) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<{ section?: string }>).detail?.section);
  window.addEventListener(OPEN_SETTINGS_EVENT, listener);
  return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
}
