import {
  meetingRecordingConfigInputSchema,
  type MeetingProcessingConfig,
  type MeetingProcessingConfigError,
} from "../contracts/meetingRecording.js";
import { BYOK_API_KEYS } from "../config/secretKeys.js";
import { selectResolvedMeetingTranscription, selectResolvedNoteFormatting } from "../config/settingsSelectors.js";
import { DETAILED_NOTES_KEY, MEETING_INPUT_PREAMBLE } from "./builtinActions.js";
import { appendDictionarySuffix } from "../config/prompts.js";
import { getSettings } from "../stores/settingsStore.js";
import { getBaseLanguageCode } from "../utils/languageSupport.js";
import { getActions } from "../stores/actionStore.js";

const credentialRefForProvider = (provider: string): string | undefined => {
  if (provider === "custom") return "CUSTOM_TRANSCRIPTION_API_KEY";
  return BYOK_API_KEYS.find((entry) => entry.base === provider)?.env;
};

export function snapshotMeetingRecordingConfig(transcriptionOverride?: MeetingProcessingConfig["transcription"]): {
  config: MeetingProcessingConfig | null;
  configError: MeetingProcessingConfigError | null;
} {
  const state = getSettings();
  let transcription: unknown = transcriptionOverride ?? null;

  if (transcriptionOverride === undefined) {
    const meeting = selectResolvedMeetingTranscription(state);
    const language = getBaseLanguageCode(state.preferredLanguage) ?? "auto";
    const credentialRef = credentialRefForProvider(meeting.cloudTranscriptionProvider);

    if (meeting.transcriptionMode === "local") {
      const provider = meeting.localTranscriptionProvider;
      const model =
        provider === "whisper"
          ? meeting.whisperModel
          : provider === "nvidia"
            ? meeting.parakeetModel
            : meeting.cohereModel;
      transcription = {
        mode: "local",
        language,
        dictionaryHints: state.customDictionary ?? [],
        local: { provider, model, options: { diarize: state.speakerDiarizationEnabled !== false } },
      };
    } else if (meeting.transcriptionMode === "providers") {
      transcription = {
        mode: "providers",
        provider: meeting.cloudTranscriptionProvider,
        model: meeting.cloudTranscriptionModel,
        language,
        dictionaryHints: state.customDictionary ?? [],
        ...(meeting.cloudTranscriptionProvider === "custom" && meeting.cloudTranscriptionBaseUrl
          ? { baseUrl: meeting.cloudTranscriptionBaseUrl }
          : {}),
        ...(credentialRef ? { credentialRef } : {}),
      };
    }
  }

  if (!transcription) {
    return { config: null, configError: { code: "unsupported-transcription-route" } };
  }

  const formatting = selectResolvedNoteFormatting(state);
  const detailedNotes = getActions().find((action) => action.translation_key === DETAILED_NOTES_KEY);
  if (!detailedNotes) return { config: null, configError: { code: "detailed-notes-action-missing" } };
  let summary: Record<string, unknown> | null = null;
  if (
    detailedNotes &&
    (formatting.mode === "providers" || formatting.mode === "local" || formatting.mode === "self-hosted" || formatting.mode === "enterprise" || formatting.mode === "agent")
  ) {
    summary = {
      actionId: DETAILED_NOTES_KEY,
      instruction: appendDictionarySuffix(
        MEETING_INPUT_PREAMBLE + detailedNotes.prompt,
        state.customDictionary ?? [],
        state.uiLanguage
      ),
      reasoningMode: formatting.mode,
      ...(formatting.mode === "agent"
        ? { agentProvider: formatting.agentProvider, model: formatting.agentModel, agentReasoningLevel: formatting.agentReasoningLevel }
        : { ...(formatting.provider ? { provider: formatting.provider } : {}), ...(formatting.model ? { model: formatting.model } : {}) }),
      ...(formatting.mode === "providers" && formatting.cloudBaseUrl
        ? { cloudBaseUrl: formatting.cloudBaseUrl }
        : {}),
      ...(formatting.mode === "self-hosted" && formatting.remoteUrl
        ? { remoteUrl: formatting.remoteUrl }
        : {}),
      ...(formatting.mode === "providers" && formatting.provider === "custom"
        ? { credentialRef: "CUSTOM_CLEANUP_API_KEY" }
        : {}),
      ...(formatting.mode === "enterprise"
        ? {
            ...(formatting.provider === "azure" ? { credentialRef: "AZURE_OPENAI_API_KEY" } : {}),
            ...(formatting.provider === "vertex" ? { credentialRef: "VERTEX_API_KEY" } : {}),
            enterprise: {
              ...(formatting.provider === "bedrock"
                ? {
                    bedrockRegion: state.bedrockRegion,
                    bedrockProfile: state.bedrockProfile,
                    bedrockAccessKeyRef: "BEDROCK_ACCESS_KEY_ID",
                    bedrockSecretAccessKeyRef: "BEDROCK_SECRET_ACCESS_KEY",
                    bedrockSessionTokenRef: "BEDROCK_SESSION_TOKEN",
                  }
                : {}),
              ...(formatting.provider === "azure"
                ? {
                    azureEndpoint: state.azureEndpoint,
                    azureApiVersion: state.azureApiVersion,
                  }
                : {}),
              ...(formatting.provider === "vertex"
                ? {
                    vertexProject: state.vertexProject,
                    vertexLocation: state.vertexLocation,
                  }
                : {}),
            },
          }
        : {}),
      options: { disableThinking: state.noteFormattingDisableThinking, cloudMode: formatting.cloudMode },
    };
  }

  const parsed = meetingRecordingConfigInputSchema.safeParse({
    config: { transcription, summary },
    configError: null,
  });
  return parsed.success
    ? { config: parsed.data.config, configError: null }
    : { config: null, configError: { code: "invalid-processing-config" } };
}
