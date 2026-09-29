// Narrow input snapshots for the pure settings selectors in
// config/settingsSelectors. These describe only the fields the selectors
// actually read — no setters, no store instance — so the pure graph stays
// independent of the store, Electron and DOM.

export type LocalTranscriptionProvider = "whisper" | "nvidia" | "cohere";

export type InferenceMode = "providers" | "local" | "self-hosted" | "enterprise" | "agent";

export type SelfHostedType = "openai-compatible" | "lan";

export type CloudReasonPurpose = "cleanup" | "assistant" | "translation" | "noteFormatting";

/** Base (dictation) transcription fields the meeting/upload selectors inherit from. */
export interface BaseTranscriptionSettings {
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

/** Note Recording overrides on top of the base transcription settings. */
export interface MeetingTranscriptionSettings {
  meetingTranscriptionMode: InferenceMode;
  meetingUseLocalWhisper: boolean;
  meetingWhisperModel: string;
  meetingLocalTranscriptionProvider: LocalTranscriptionProvider;
  meetingParakeetModel: string;
  meetingCohereModel: string;
  meetingCloudTranscriptionProvider: string;
  meetingCloudTranscriptionModel: string;
  meetingCloudTranscriptionBaseUrl: string;
  meetingCloudTranscriptionMode: string;
  meetingRemoteTranscriptionType: SelfHostedType;
  meetingRemoteTranscriptionUrl: string;
}

/** Audio upload overrides on top of the base transcription settings. */
export interface UploadTranscriptionSettings {
  uploadTranscriptionMode: InferenceMode;
  uploadUseLocalWhisper: boolean;
  uploadWhisperModel: string;
  uploadLocalTranscriptionProvider: LocalTranscriptionProvider;
  uploadParakeetModel: string;
  uploadCohereModel: string;
  uploadCloudTranscriptionProvider: string;
  uploadCloudTranscriptionModel: string;
  uploadCloudTranscriptionBaseUrl: string;
  uploadCloudTranscriptionMode: string;
}

/** Routing fields of the cleanup scope as they live in the store. */
export interface CleanupScopeSettings {
  cleanupMode: InferenceMode;
  cleanupProvider: string;
  cleanupModel: string;
  cleanupCloudMode: string;
  cleanupCloudBaseUrl: string;
  cleanupRemoteUrl: string;
  cleanupCustomApiKey: string;
  cleanupDisableThinking: boolean;
}

/** Routing fields of the note-formatting scope as they live in the store. */
export interface NoteFormattingScopeSettings {
  noteFormattingMode: InferenceMode;
  noteFormattingProvider: string;
  noteFormattingModel: string;
  noteFormattingCloudMode: string;
  noteFormattingCloudBaseUrl: string;
  noteFormattingRemoteUrl: string;
  noteFormattingCustomApiKey: string;
  noteFormattingDisableThinking: boolean;
  noteFormattingBbProvider?: string;
  noteFormattingBbModel?: string;
  noteFormattingBbReasoningLevel?: string;
}

/** Routing fields of the chat-intelligence scope as they live in the store. */
export interface ChatAgentScopeSettings {
  chatAgentMode: InferenceMode;
  chatAgentProvider: string;
  chatAgentModel: string;
  chatAgentCloudMode: string;
  chatAgentCloudBaseUrl: string;
  chatAgentRemoteUrl: string;
  chatAgentCustomApiKey: string;
  chatAgentDisableThinking: boolean;
  chatAgentBbProvider?: string;
  chatAgentBbModel?: string;
  chatAgentBbReasoningLevel?: string;
}

/**
 * App-wide bb harness preferences. Seeded once from bb's own provider order and
 * default, then owned by Gristmill and never written back to bb.
 */
export interface BbAgentPreferences {
  order: string[];
  disabled: string[];
  defaultProvider: string;
  defaults: Record<string, { model: string; reasoningLevel: string }>;
}

/** Everything the four selectors read from a settings snapshot. */
export type InferenceSettingsSnapshot = BaseTranscriptionSettings &
  MeetingTranscriptionSettings &
  UploadTranscriptionSettings &
  CleanupScopeSettings &
  NoteFormattingScopeSettings &
  ChatAgentScopeSettings & { bbAgentPreferences?: BbAgentPreferences | null };
