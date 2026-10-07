import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../../../stores/settingsStore";
import { PROVIDER_DIRECTORY } from "./providerDirectory";

const ALL_KEYS = [
  ...new Set(PROVIDER_DIRECTORY.flatMap((entry) => entry.fields.map((field) => field.key))),
];

/** Current credential values for every directory provider, keyed by credential. */
export interface CredentialValues {
  [key: string]: string;
}

export function useCredentialValues(): CredentialValues {
  return useSettingsStore(
    useShallow((state) =>
      // SAFETY: ALL_KEYS are exactly the CredentialKey values drawn from the
      // directory below, and every store credential is a string.
      Object.fromEntries(ALL_KEYS.map((key) => [key, state[key] ?? ""]))
    )
  );
}
