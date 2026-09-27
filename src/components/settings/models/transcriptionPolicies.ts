import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../../../stores/settingsStore";
import { selectResolvedMeetingTranscription, selectResolvedUploadTranscription } from "../../../config/settingsSelectors";
import { getMeetingFileTranscriptionProviders, isSherpaLocalProvider } from "../../../models/ModelRegistry";
import { selectCloudModel } from "./taskModels";

/**
 * Rules the old per-task pickers enforced while open: a meeting must use a
 * post-Stop file model, and Macs that cannot run the sherpa runtime fall back to
 * Whisper instead of keeping an unrunnable local model.
 */
export function useTranscriptionPolicies(sherpaSupported: boolean) {
  const meeting = useSettingsStore(useShallow((state) => selectResolvedMeetingTranscription(state)));
  const upload = useSettingsStore(useShallow((state) => selectResolvedUploadTranscription(state)));

  useEffect(() => {
    if (meeting.transcriptionMode !== "providers") return;
    const providers = getMeetingFileTranscriptionProviders();
    const provider = providers.find((entry) => entry.id === meeting.cloudTranscriptionProvider) ?? providers[0];
    if (!provider) return;
    const model = provider.models.some((entry) => entry.id === meeting.cloudTranscriptionModel)
      ? meeting.cloudTranscriptionModel
      : provider.models[0]?.id ?? "";
    if (provider.id !== meeting.cloudTranscriptionProvider || model !== meeting.cloudTranscriptionModel) {
      selectCloudModel("meeting", provider.id, model);
    }
  }, [meeting.transcriptionMode, meeting.cloudTranscriptionProvider, meeting.cloudTranscriptionModel]);

  useEffect(() => {
    if (sherpaSupported) return;
    const store = useSettingsStore.getState();
    if (isSherpaLocalProvider(meeting.localTranscriptionProvider)) store.setMeetingLocalTranscriptionProvider("whisper");
    if (isSherpaLocalProvider(upload.localTranscriptionProvider)) store.setUploadLocalTranscriptionProvider("whisper");
  }, [sherpaSupported, meeting.localTranscriptionProvider, upload.localTranscriptionProvider]);
}
