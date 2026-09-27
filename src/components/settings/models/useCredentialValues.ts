import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../../../stores/settingsStore";
import { PROVIDER_DIRECTORY, type CredentialKey } from "./providerDirectory";

const ALL_KEYS = [...new Set(PROVIDER_DIRECTORY.flatMap((entry) => entry.fields.map((field) => field.key)))];

/** Current credential values for every directory provider. */
export function useCredentialValues(): Record<CredentialKey, string> {
  return useSettingsStore(
    useShallow((state) => Object.fromEntries(ALL_KEYS.map((key) => [key, state[key] ?? ""])) as Record<CredentialKey, string>)
  );
}
