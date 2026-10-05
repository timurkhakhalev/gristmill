import type {
  CloudReasonPurpose,
  InferenceMode,
  InferenceSettingsSnapshot,
} from "../contracts/inferenceSettings";

// Keys point into the narrow selector snapshot, not the whole store: string
// fields must reference string snapshot fields, the mode field a mode field,
// disableThinking a boolean field. The store's SettingsState structurally
// satisfies the snapshot, so the same keys read its state.
type StringKey = NonNullable<
  {
    [K in keyof InferenceSettingsSnapshot]: NonNullable<InferenceSettingsSnapshot[K]> extends string
      ? K
      : never;
  }[keyof InferenceSettingsSnapshot]
>;

type ModeKey = NonNullable<
  {
    [K in keyof InferenceSettingsSnapshot]: InferenceSettingsSnapshot[K] extends InferenceMode
      ? K
      : never;
  }[keyof InferenceSettingsSnapshot]
>;

type BooleanKey = NonNullable<
  {
    [K in keyof InferenceSettingsSnapshot]: InferenceSettingsSnapshot[K] extends boolean
      ? K
      : never;
  }[keyof InferenceSettingsSnapshot]
>;

export interface InferenceScopeStoreKeys {
  mode: ModeKey;
  provider: StringKey;
  model: StringKey;
  cloudMode?: StringKey;
  cloudBaseUrl?: StringKey;
  remoteUrl?: StringKey;
  customApiKey?: StringKey;
  disableThinking?: BooleanKey;
  agentProvider?: StringKey;
  agentModel?: StringKey;
  agentReasoningLevel?: StringKey;
}

export interface InferenceScopeDefinition {
  storeKeys: InferenceScopeStoreKeys;
  fallbackScope?: InferenceScopeId;
  /** Configured fallback purpose for this inference scope. */
  cloudPurpose: CloudReasonPurpose;
}

export type InferenceScopeId = "cleanup" | "noteFormatting" | "chatIntelligence";

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
      agentProvider: "noteFormattingBbProvider",
      agentModel: "noteFormattingBbModel",
      agentReasoningLevel: "noteFormattingBbReasoningLevel",
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
      agentProvider: "chatAgentBbProvider",
      agentModel: "chatAgentBbModel",
      agentReasoningLevel: "chatAgentBbReasoningLevel",
    },
  },
} as const satisfies Record<InferenceScopeId, InferenceScopeDefinition>;

export type InferenceScope = keyof typeof INFERENCE_SCOPES;

// Indexed lookup keeps `def` typed as InferenceScopeDefinition (so the
// optional fallbackScope exists on every branch) while the const object still
// pins the exact key/value pairs for type-checked storeKeys.
export function inferenceScopeDefinition(scope: InferenceScope): InferenceScopeDefinition {
  return INFERENCE_SCOPES[scope];
}
