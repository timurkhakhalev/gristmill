import { useSettingsStore } from "../stores/settingsStore";

export function useDateTimePreferences() {
  const dateFormat = useSettingsStore((state) => state.dateFormat);
  const timeFormat = useSettingsStore((state) => state.timeFormat);

  return { dateFormat, timeFormat };
}
