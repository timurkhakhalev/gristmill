import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Key, Cpu, Network } from "../icons";
import { useSettingsStore } from "../../stores/settingsStore";
import type { LocalTranscriptionProvider } from "../../contracts/inferenceSettings";
import { InferenceModeSelector, SettingsRow } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import SelfHostedPanel from "../SelfHostedPanel";
import type { InferenceMode } from "../../contracts/inferenceSettings";

export function MeetingSpeakerDetectionRow() {
  const { t } = useTranslation();
  const speakerDiarizationEnabled = useSettingsStore((s) => s.speakerDiarizationEnabled);
  const setSpeakerDiarizationEnabled = useSettingsStore((s) => s.setSpeakerDiarizationEnabled);

  return (
    <SettingsRow
      label={t("settings.meeting.speakerDetection.title")}
      description={t("settings.meeting.speakerDetection.description")}
    >
      <Toggle checked={speakerDiarizationEnabled} onChange={setSpeakerDiarizationEnabled} />
    </SettingsRow>
  );
}

const noop = () => {};

export function MeetingTranscriptionPanel() {
  const { t } = useTranslation();
  const {
    meetingTranscriptionMode,
    setMeetingTranscriptionMode,
    setMeetingUseLocalWhisper,
    meetingWhisperModel,
    setMeetingWhisperModel,
    meetingLocalTranscriptionProvider,
    setMeetingLocalTranscriptionProvider,
    meetingParakeetModel,
    setMeetingParakeetModel,
    meetingCohereModel,
    setMeetingCohereModel,
    meetingCloudTranscriptionProvider,
    setMeetingCloudTranscriptionProvider,
    meetingCloudTranscriptionModel,
    setMeetingCloudTranscriptionModel,
    meetingCloudTranscriptionBaseUrl,
    setMeetingCloudTranscriptionBaseUrl,
    setMeetingCloudTranscriptionMode,
    remoteTranscriptionUrl,
    setRemoteTranscriptionUrl,
    remoteTranscriptionModel,
    setRemoteTranscriptionModel,
  } = useSettingsStore();
  const transcriptionModes: InferenceModeOption[] = [
      {
        id: "providers",
        label: t("settingsPage.transcription.modes.providers"),
        description: t("settingsPage.transcription.modes.providersDesc"),
        icon: <Key className="w-4 h-4" />,
      },
      {
        id: "local",
        label: t("settingsPage.transcription.modes.local"),
        description: t("settingsPage.transcription.modes.localDesc"),
        icon: <Cpu className="w-4 h-4" />,
      },
      {
        id: "self-hosted",
        label: t("settingsPage.transcription.modes.selfHosted"),
        description: t("settingsPage.transcription.modes.selfHostedDesc"),
        icon: <Network className="w-4 h-4" />,
      },
    ];
  const effectiveTranscriptionMode = meetingTranscriptionMode;
  const handleTranscriptionModeSelect = (mode: InferenceMode) => {
    if (mode === effectiveTranscriptionMode) return;
    setMeetingTranscriptionMode(mode);
    setMeetingUseLocalWhisper(mode === "local");
    setMeetingCloudTranscriptionMode("byok");
  };

  const handleLocalTranscriptionModelSelect = useCallback(
    (modelId: string, providerId?: string) => {
      const provider = providerId ?? meetingLocalTranscriptionProvider;
      if (provider === "nvidia") {
        setMeetingParakeetModel(modelId);
      } else if (provider === "cohere") {
        setMeetingCohereModel(modelId);
      } else {
        setMeetingWhisperModel(modelId);
      }
    },
    [
      meetingLocalTranscriptionProvider,
      setMeetingParakeetModel,
      setMeetingCohereModel,
      setMeetingWhisperModel,
    ]
  );

  const renderTranscriptionPicker = (mode: "cloud" | "local") => (
    <TranscriptionModelPicker
      streamingOnly
      transcriptionContext="meeting"
      selectedCloudProvider={meetingCloudTranscriptionProvider}
      onCloudProviderSelect={setMeetingCloudTranscriptionProvider}
      selectedCloudModel={meetingCloudTranscriptionModel}
      onCloudModelSelect={setMeetingCloudTranscriptionModel}
      selectedLocalModel={
        meetingLocalTranscriptionProvider === "nvidia"
          ? meetingParakeetModel
          : meetingLocalTranscriptionProvider === "cohere"
            ? meetingCohereModel
            : meetingWhisperModel
      }
      onLocalModelSelect={handleLocalTranscriptionModelSelect}
      selectedLocalProvider={meetingLocalTranscriptionProvider}
      onLocalProviderSelect={(id) => setMeetingLocalTranscriptionProvider(id as LocalTranscriptionProvider)}
      useLocalWhisper={mode === "local"}
      onModeChange={noop}
      mode={mode}
      cloudTranscriptionBaseUrl={meetingCloudTranscriptionBaseUrl}
      setCloudTranscriptionBaseUrl={setMeetingCloudTranscriptionBaseUrl}
      variant="settings"
    />
  );

  return (
    <div className="space-y-3">
      <InferenceModeSelector
        modes={transcriptionModes}
        activeMode={effectiveTranscriptionMode}
        onSelect={handleTranscriptionModeSelect}
      />

      {effectiveTranscriptionMode === "providers" && renderTranscriptionPicker("cloud")}
      {effectiveTranscriptionMode === "local" && renderTranscriptionPicker("local")}
      {effectiveTranscriptionMode === "self-hosted" && (
        <SelfHostedPanel
          service="transcription"
          url={remoteTranscriptionUrl}
          onUrlChange={setRemoteTranscriptionUrl}
          model={remoteTranscriptionModel}
          onModelChange={setRemoteTranscriptionModel}
        />
      )}
      <MeetingSpeakerDetectionRow />
    </div>
  );
}
