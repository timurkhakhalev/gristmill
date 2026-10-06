// Store keys of every inference scope pointing at a local model that is no
// longer installed. Only "local" scopes are candidates — in every other mode the
// selected id names a remote model, which the local model cache knows nothing
// about. `scopes` is Object.values(INFERENCE_SCOPES).
import type { InferenceSettingsSnapshot } from "../contracts/inferenceSettings.js";

// Only string-valued routing keys are read here (a scope's mode and model), so
// the settings input is the store snapshot projected to those keys.
type StringSettingKey = {
  [K in keyof InferenceSettingsSnapshot]-?: InferenceSettingsSnapshot[K] extends string ? K : never;
}[keyof InferenceSettingsSnapshot];

export interface LocalScopeEntry {
  storeKeys: { model: StringSettingKey; mode: StringSettingKey };
}

export type LocalModelSelectionSettings = Partial<InferenceSettingsSnapshot>;

export function findStaleLocalModelKeys(
  scopes: LocalScopeEntry[],
  settings: LocalModelSelectionSettings,
  isInstalled: (modelId: string) => boolean
): string[] {
  return scopes
    .filter(({ storeKeys }) => {
      const selected = settings[storeKeys.model];

      return settings[storeKeys.mode] === "local" && !!selected && !isInstalled(selected);
    })
    .map(({ storeKeys }) => storeKeys.model);
}
