import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Key, Cpu, Network } from "../icons";
import { useSettingsStore } from "../../stores/settingsStore";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import SelfHostedPanel from "../SelfHostedPanel";
import type { InferenceMode } from "../../types/electron";

export function UploadTranscriptionPanel() {
  const { t } = useTranslation();
  const {
    uploadTranscriptionMode,
    setUploadTranscriptionMode,
    setUploadUseLocalWhisper,
    uploadWhisperModel,
    setUploadWhisperModel,
    uploadLocalTranscriptionProvider,
    setUploadLocalTranscriptionProvider,
    uploadParakeetModel,
    setUploadParakeetModel,
    uploadCohereModel,
    setUploadCohereModel,
    uploadCloudTranscriptionProvider,
    setUploadCloudTranscriptionProvider,
    uploadCloudTranscriptionModel,
    setUploadCloudTranscriptionModel,
    uploadCloudTranscriptionBaseUrl,
    setUploadCloudTranscriptionBaseUrl,
    setUploadCloudTranscriptionMode,
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
  const effectiveTranscriptionMode = uploadTranscriptionMode;
  const handleTranscriptionModeSelect = (mode: InferenceMode) => {
    if (mode === effectiveTranscriptionMode) return;
    setUploadTranscriptionMode(mode);
    setUploadUseLocalWhisper(mode === "local");
    setUploadCloudTranscriptionMode("byok");
  };

  const handleLocalTranscriptionModelSelect = useCallback(
    (modelId: string, providerId?: string) => {
      const provider = providerId ?? uploadLocalTranscriptionProvider;
      if (provider === "nvidia") {
        setUploadParakeetModel(modelId);
      } else if (provider === "cohere") {
        setUploadCohereModel(modelId);
      } else {
        setUploadWhisperModel(modelId);
      }
    },
    [
      uploadLocalTranscriptionProvider,
      setUploadParakeetModel,
      setUploadCohereModel,
      setUploadWhisperModel,
    ]
  );

  const renderTranscriptionPicker = (mode: "cloud" | "local") => (
    <TranscriptionModelPicker
      transcriptionContext="upload"
      selectedCloudProvider={uploadCloudTranscriptionProvider}
      onCloudProviderSelect={setUploadCloudTranscriptionProvider}
      selectedCloudModel={uploadCloudTranscriptionModel}
      onCloudModelSelect={setUploadCloudTranscriptionModel}
      selectedLocalModel={
        uploadLocalTranscriptionProvider === "nvidia"
          ? uploadParakeetModel
          : uploadLocalTranscriptionProvider === "cohere"
            ? uploadCohereModel
            : uploadWhisperModel
      }
      onLocalModelSelect={handleLocalTranscriptionModelSelect}
      selectedLocalProvider={uploadLocalTranscriptionProvider}
      onLocalProviderSelect={setUploadLocalTranscriptionProvider}
      useLocalWhisper={mode === "local"}
      onModeChange={() => {}}
      mode={mode}
      cloudTranscriptionBaseUrl={uploadCloudTranscriptionBaseUrl}
      setCloudTranscriptionBaseUrl={setUploadCloudTranscriptionBaseUrl}
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
    </div>
  );
}
