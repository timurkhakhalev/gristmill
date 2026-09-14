import type { SettingsState } from "../stores/settingsStore";
import type { CloudReasonPurpose } from "../types/electron";

export interface InferenceScopeStoreKeys {
  mode: keyof SettingsState;
  provider: keyof SettingsState;
  model: keyof SettingsState;
  cloudMode?: keyof SettingsState;
  cloudBaseUrl?: keyof SettingsState;
  remoteUrl?: keyof SettingsState;
  customApiKey?: keyof SettingsState;
  disableThinking?: keyof SettingsState;
}

export interface InferenceScopeDefinition {
  storeKeys: InferenceScopeStoreKeys;
  fallbackScope?: string;
  /** Configured fallback purpose for this inference scope. */
  cloudPurpose: CloudReasonPurpose;
}

export const INFERENCE_SCOPES = {
  cleanup: {
    cloudPurpose: "cleanup",
    storeKeys: {
      mode: "cleanupMode",
      provider: "cleanupProvider",
      model: "cleanupModel",
      cloudMode: "cleanupCloudMode",
      cloudBaseUrl: "cleanupCloudBaseUrl",
      remoteUrl: "cleanupRemoteUrl",
      customApiKey: "cleanupCustomApiKey",
      disableThinking: "cleanupDisableThinking",
    },
  },
  noteFormatting: {
    cloudPurpose: "noteFormatting",
    storeKeys: {
      mode: "noteFormattingMode",
      provider: "noteFormattingProvider",
      model: "noteFormattingModel",
      cloudMode: "noteFormattingCloudMode",
      cloudBaseUrl: "noteFormattingCloudBaseUrl",
      remoteUrl: "noteFormattingRemoteUrl",
      customApiKey: "noteFormattingCustomApiKey",
      disableThinking: "noteFormattingDisableThinking",
    },
    fallbackScope: "cleanup",
  },
  // Runs typed chat conversations (Control Panel, note and container chat).
  chatIntelligence: {
    cloudPurpose: "assistant",
    storeKeys: {
      mode: "chatAgentMode",
      provider: "chatAgentProvider",
      model: "chatAgentModel",
      cloudMode: "chatAgentCloudMode",
      cloudBaseUrl: "chatAgentCloudBaseUrl",
      remoteUrl: "chatAgentRemoteUrl",
      customApiKey: "chatAgentCustomApiKey",
      disableThinking: "chatAgentDisableThinking",
    },
  },
} as const satisfies Record<string, InferenceScopeDefinition>;

export type InferenceScope = keyof typeof INFERENCE_SCOPES;
