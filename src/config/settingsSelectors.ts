// Pure derived-settings selectors: plain functions from a settings snapshot to
// the effective transcription / LLM configuration. No store, no localStorage,
// no i18n, no Electron, no model discovery — importable in a bare Node process.
// The store's SettingsState structurally satisfies InferenceSettingsSnapshot.

import type {
  InferenceMode,
  InferenceSettingsSnapshot,
  LocalTranscriptionProvider,
  SelfHostedType,
} from "../contracts/inferenceSettings";
import { inferenceScopeDefinition, type InferenceScope } from "./inferenceScopes";
import {
  DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER,
  STREAMING_ONLY_PROVIDERS,
} from "./transcriptionCapabilities";
import { inheritsFallbackEndpoint } from "../helpers/reasoningRouting";
import { resolveBbSelection } from "./bbAgentPreferences";

export interface ResolvedMeetingTranscription {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cohereModel: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
}

export const selectResolvedMeetingTranscription = (
  state: InferenceSettingsSnapshot
): ResolvedMeetingTranscription => ({
  useLocalWhisper: state.meetingUseLocalWhisper,
  whisperModel: state.meetingWhisperModel || state.whisperModel,
  localTranscriptionProvider: state.meetingLocalTranscriptionProvider,
  parakeetModel: state.meetingParakeetModel || state.parakeetModel,
  cohereModel: state.meetingCohereModel || state.cohereModel,
  cloudTranscriptionProvider:
    state.meetingCloudTranscriptionProvider || state.cloudTranscriptionProvider,
  cloudTranscriptionModel: state.meetingCloudTranscriptionModel || state.cloudTranscriptionModel,
  cloudTranscriptionBaseUrl:
    state.meetingCloudTranscriptionBaseUrl || state.cloudTranscriptionBaseUrl || "",
  cloudTranscriptionMode: state.meetingCloudTranscriptionMode || state.cloudTranscriptionMode,
  transcriptionMode: state.meetingTranscriptionMode,
  remoteTranscriptionType: state.meetingRemoteTranscriptionType,
  remoteTranscriptionUrl: state.meetingRemoteTranscriptionUrl || state.remoteTranscriptionUrl,
});

export interface ResolvedUploadTranscription {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cohereModel: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
}

// Audio upload is batch (not streaming), so unset values fall back to the base
// transcription settings — matching the behavior before upload had its own context.
// A realtime-only transcription provider is the exception: it has no batch route, so
// inheriting it would fail every upload closed. Uploads take the default provider
// instead, and the base model stays behind with the provider it belongs to.
export const selectResolvedUploadTranscription = (
  state: InferenceSettingsSnapshot
): ResolvedUploadTranscription => {
  const inheritsBaseProvider = !STREAMING_ONLY_PROVIDERS.has(state.cloudTranscriptionProvider);

  return {
    useLocalWhisper: state.uploadUseLocalWhisper,
    whisperModel: state.uploadWhisperModel || state.whisperModel,
    localTranscriptionProvider: state.uploadLocalTranscriptionProvider,
    parakeetModel: state.uploadParakeetModel || state.parakeetModel,
    cohereModel: state.uploadCohereModel || state.cohereModel,
    cloudTranscriptionProvider:
      state.uploadCloudTranscriptionProvider ||
      (inheritsBaseProvider
        ? state.cloudTranscriptionProvider
        : DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER),
    cloudTranscriptionModel:
      state.uploadCloudTranscriptionModel ||
      (inheritsBaseProvider ? state.cloudTranscriptionModel : ""),
    cloudTranscriptionBaseUrl:
      state.uploadCloudTranscriptionBaseUrl || state.cloudTranscriptionBaseUrl || "",
    cloudTranscriptionMode: state.uploadCloudTranscriptionMode || state.cloudTranscriptionMode,
    transcriptionMode: state.uploadTranscriptionMode,
  };
};

export interface ResolvedNoteFormatting {
  provider: string;
  model: string;
  mode: InferenceMode;
  cloudMode: string;
  cloudBaseUrl: string;
  remoteUrl: string;
  customApiKey: string;
  agentProvider?: string;
  agentModel?: string;
  agentReasoningLevel?: string;
}

export const selectResolvedNoteFormatting = (
  state: InferenceSettingsSnapshot
): ResolvedNoteFormatting => {
  const cfg = selectResolvedLLMConfig(state, "noteFormatting");
  const cleanup = selectResolvedLLMConfig(state, "cleanup");

  // The endpoint falls back to the cleanup scope, so the key that opens it must too,
  // or an inherited endpoint gets called with no credential.
  const borrowsEndpoint = inheritsFallbackEndpoint(
    {
      mode: cfg.mode,
      cloudBaseUrl: state.noteFormattingCloudBaseUrl,
      remoteUrl: state.noteFormattingRemoteUrl,
    },
    cleanup.mode
  );

  return {
    provider: cfg.provider,
    model: cfg.model,
    mode: cfg.mode,
    cloudMode: cfg.cloudMode || "",
    cloudBaseUrl: cfg.cloudBaseUrl || "",
    remoteUrl: cfg.remoteUrl || "",
    customApiKey: cfg.customApiKey || (borrowsEndpoint ? cleanup.customApiKey || "" : ""),
    ...(cfg.mode === "agent"
      ? {
          agentProvider: cfg.agentProvider,
          agentModel: cfg.agentModel,
          agentReasoningLevel: cfg.agentReasoningLevel,
        }
      : {}),
  };
};

export interface ResolvedLLMConfig {
  scope: InferenceScope;
  mode: InferenceMode;
  provider: string;
  model: string;
  cloudMode?: string;
  cloudBaseUrl?: string;
  remoteUrl?: string;
  customApiKey?: string;
  disableThinking: boolean;
  agentProvider?: string;
  agentModel?: string;
  agentReasoningLevel?: string;
  /** True when the scope follows the app-wide default bb harness. */
  agentUsesDefault?: boolean;
}

export const selectResolvedLLMConfig = (
  state: InferenceSettingsSnapshot,
  scope: InferenceScope
): ResolvedLLMConfig => {
  const def = inferenceScopeDefinition(scope);

  const fallback = def.fallbackScope
    ? selectResolvedLLMConfig(state, def.fallbackScope)
    : undefined;

  const readString = (
    field:
      | "provider"
      | "model"
      | "cloudMode"
      | "cloudBaseUrl"
      | "remoteUrl"
      | "customApiKey"
      | "agentProvider"
      | "agentModel"
      | "agentReasoningLevel"
  ): string | undefined => {
    const key = def.storeKeys[field];

    if (!key) return undefined;

    return state[key] || undefined;
  };

  const disableThinkingKey = def.storeKeys.disableThinking;
  const disableThinking = disableThinkingKey ? state[disableThinkingKey] : true;

  const localConfig: ResolvedLLMConfig = {
    scope,
    mode: state[def.storeKeys.mode],
    provider: readString("provider") || fallback?.provider || "",
    model: readString("model") || fallback?.model || "",
    cloudMode: readString("cloudMode") || fallback?.cloudMode,
    cloudBaseUrl: readString("cloudBaseUrl") || fallback?.cloudBaseUrl,
    remoteUrl: readString("remoteUrl") || fallback?.remoteUrl,
    // Not inherited here: the settings editor renders this field, and a borrowed key
    // in it would be committed to this scope's storage by an idle edit. Inheritance
    // belongs on the request path — see selectResolvedNoteFormatting.
    customApiKey: readString("customApiKey"),
    disableThinking,
    ...(state[def.storeKeys.mode] === "agent"
      ? (() => {
          const selection = resolveBbSelection(state.bbAgentPreferences, {
            provider: readString("agentProvider"),
            model: readString("agentModel"),
            reasoningLevel: readString("agentReasoningLevel"),
          });

          return {
            agentProvider: selection.provider,
            agentModel: selection.model,
            agentReasoningLevel: selection.reasoningLevel,
            agentUsesDefault: !readString("agentProvider"),
          };
        })()
      : {}),
  };

  return localConfig;
};
