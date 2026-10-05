// Reads and writes the model each task uses. The store keeps separate routing
// keys per task (meeting, upload, summary, chat); this module maps a picker
// choice onto those keys so the UI never touches them directly.
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore, setResolvedLLMConfig } from "../../../stores/settingsStore";
import {
  selectResolvedLLMConfig,
  selectResolvedMeetingTranscription,
  selectResolvedUploadTranscription,
} from "../../../config/settingsSelectors";
import type { LocalTranscriptionProvider } from "../../../contracts/inferenceSettings";
import type { LocalModelEntry } from "./inventoryContext";

export type SpeechTask = "meeting" | "upload";

export type LanguageTask = "noteFormatting" | "chatIntelligence";

export type ModelTask = SpeechTask | LanguageTask;

export type ModelSource = "cloud" | "local" | "self-hosted" | "bb" | "enterprise";

export const isSpeechTask = (task: ModelTask): task is SpeechTask =>
  task === "meeting" || task === "upload";

/** Sources a task can pick from, in tab order. */
export function taskSources(task: ModelTask): ModelSource[] {
  if (task === "meeting") return ["cloud", "local"];

  if (task === "upload") return ["cloud", "local"];

  return ["cloud", "local", "self-hosted", "bb"];
}

export interface TaskSelection {
  source: ModelSource;
  providerId: string;
  modelId: string;
  /** bb only: reasoning level and whether the default harness is followed. */
  reasoningLevel?: string;
  followsDefault?: boolean;
  /** Self-hosted and custom endpoints. */
  endpoint?: string;
}

function localModelFor(
  backend: string,
  models: { whisperModel: string; parakeetModel: string; cohereModel: string }
) {
  return backend === "nvidia"
    ? models.parakeetModel
    : backend === "cohere"
      ? models.cohereModel
      : models.whisperModel;
}

export function useTaskSelection(task: ModelTask): TaskSelection {
  return useSettingsStore(
    useShallow((state): TaskSelection => {
      if (task === "meeting") {
        const meeting = selectResolvedMeetingTranscription(state);

        return meeting.transcriptionMode === "local"
          ? {
              source: "local",
              providerId: meeting.localTranscriptionProvider,
              modelId: localModelFor(meeting.localTranscriptionProvider, meeting),
            }
          : {
              source: "cloud",
              providerId: meeting.cloudTranscriptionProvider,
              modelId: meeting.cloudTranscriptionModel,
            };
      }

      if (task === "upload") {
        const upload = selectResolvedUploadTranscription(state);

        if (upload.transcriptionMode === "local") {
          return {
            source: "local",
            providerId: upload.localTranscriptionProvider,
            modelId: localModelFor(upload.localTranscriptionProvider, upload),
          };
        }

        if (upload.transcriptionMode === "self-hosted") {
          return {
            source: "self-hosted",
            providerId: "self-hosted",
            modelId: state.remoteTranscriptionModel,
            endpoint: state.remoteTranscriptionUrl,
          };
        }

        return {
          source: "cloud",
          providerId: upload.cloudTranscriptionProvider,
          modelId: upload.cloudTranscriptionModel,
          endpoint:
            upload.cloudTranscriptionProvider === "custom"
              ? upload.cloudTranscriptionBaseUrl
              : undefined,
        };
      }

      const config = selectResolvedLLMConfig(state, task);

      switch (config.mode) {
        case "agent":
          return {
            source: "bb",
            providerId: config.agentProvider ?? "",
            modelId: config.agentModel ?? "",
            reasoningLevel: config.agentReasoningLevel,
            followsDefault: config.agentUsesDefault !== false,
          };
        case "local":
          return { source: "local", providerId: config.provider, modelId: config.model };
        case "self-hosted":
          return {
            source: "self-hosted",
            providerId: "self-hosted",
            modelId: config.model,
            endpoint: config.remoteUrl,
          };
        case "enterprise":
          return { source: "enterprise", providerId: config.provider, modelId: config.model };
        default:
          return {
            source: "cloud",
            providerId: config.provider,
            modelId: config.model,
            endpoint: config.provider === "custom" ? config.cloudBaseUrl : undefined,
          };
      }
    })
  );
}

const SPEECH_SETTERS = {
  meeting: {
    mode: "setMeetingTranscriptionMode",
    useLocal: "setMeetingUseLocalWhisper",
    cloudMode: "setMeetingCloudTranscriptionMode",
    cloudModel: "setMeetingCloudTranscriptionModel",
    localProvider: "setMeetingLocalTranscriptionProvider",
    whisper: "setMeetingWhisperModel",
    parakeet: "setMeetingParakeetModel",
    cohere: "setMeetingCohereModel",
  },
  upload: {
    mode: "setUploadTranscriptionMode",
    useLocal: "setUploadUseLocalWhisper",
    cloudMode: "setUploadCloudTranscriptionMode",
    cloudModel: "setUploadCloudTranscriptionModel",
    localProvider: "setUploadLocalTranscriptionProvider",
    whisper: "setUploadWhisperModel",
    parakeet: "setUploadParakeetModel",
    cohere: "setUploadCohereModel",
  },
} as const;

/** Leaving a local LLM frees the llama server, as the old mode switch did. */
function stopLocalLlmIfLeaving(task: LanguageTask) {
  if (selectResolvedLLMConfig(useSettingsStore.getState(), task).mode === "local") {
    void window.electronAPI?.llamaServerStop?.();
  }
}

export function selectCloudModel(task: ModelTask, providerId: string, modelId: string): void {
  if (isSpeechTask(task)) {
    const s = useSettingsStore.getState();
    const setters = SPEECH_SETTERS[task];
    s[setters.mode]("providers");
    s[setters.useLocal](false);
    s[setters.cloudMode]("byok");
    // Remembers the outgoing provider's model before switching.
    s.switchCloudTranscriptionProvider(task, providerId);
    useSettingsStore.getState()[setters.cloudModel](modelId);

    return;
  }

  stopLocalLlmIfLeaving(task);
  setResolvedLLMConfig(task, {
    mode: "providers",
    cloudMode: "byok",
    provider: providerId,
    model: modelId,
  });
}

/** The IPC backend a local speech model runs on; Oruk models use the NVIDIA (sherpa) backend. */
export function localSpeechBackend(entry: LocalModelEntry): LocalTranscriptionProvider {
  if (entry.kind === "whisper") return "whisper";

  return entry.organization === "cohere" ? "cohere" : "nvidia";
}

export function selectLocalModel(task: ModelTask, entry: LocalModelEntry): void {
  if (isSpeechTask(task)) {
    const s = useSettingsStore.getState();
    const setters = SPEECH_SETTERS[task];
    const backend = localSpeechBackend(entry);
    s[setters.mode]("local");
    s[setters.useLocal](true);
    s[setters.localProvider](backend);
    s[
      backend === "whisper"
        ? setters.whisper
        : backend === "cohere"
          ? setters.cohere
          : setters.parakeet
    ](entry.id);

    return;
  }

  setResolvedLLMConfig(task, { mode: "local", provider: entry.organization, model: entry.id });
}

export function selectSelfHosted(task: ModelTask, modelId?: string): void {
  if (isSpeechTask(task)) return;
  stopLocalLlmIfLeaving(task);
  setResolvedLLMConfig(task, {
    mode: "self-hosted",
    ...(modelId !== undefined ? { model: modelId } : {}),
  });
}

export function selectBb(
  task: LanguageTask,
  selection: { provider: string; model: string; reasoningLevel: string } | null
): void {
  stopLocalLlmIfLeaving(task);
  setResolvedLLMConfig(
    task,
    selection
      ? {
          mode: "agent",
          agentProvider: selection.provider,
          agentModel: selection.model,
          agentReasoningLevel: selection.reasoningLevel,
        }
      : { mode: "agent", agentProvider: "", agentModel: "", agentReasoningLevel: "" }
  );
}
