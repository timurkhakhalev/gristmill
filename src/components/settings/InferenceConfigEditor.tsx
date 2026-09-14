import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Key, Cpu, Network } from "../icons";
import { useSettingsStore, selectResolvedLLMConfig, setResolvedLLMConfig } from "../../stores/settingsStore";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import OpenAICompatiblePanel from "../OpenAICompatiblePanel";
import { Toggle } from "../ui/toggle";
import type { InferenceMode } from "../../types/electron";
import type { InferenceScope } from "../../config/inferenceScopes";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";

interface InferenceConfigEditorProps { scope: InferenceScope; onModeChange?: (mode: InferenceMode) => void; allowedModes?: InferenceMode[]; }

export default function InferenceConfigEditor({ scope, onModeChange, allowedModes }: InferenceConfigEditorProps) {
  const { t } = useTranslation();
  const config = useSettingsStore(useShallow((settings) => selectResolvedLLMConfig(settings, scope)));
  const modes: InferenceModeOption[] = [
    { id: "providers", label: t("settingsPage.aiModels.modes.providers"), description: t("settingsPage.aiModels.modes.providersDesc"), icon: <Key className="w-4 h-4" /> },
    { id: "local", label: t("settingsPage.aiModels.modes.local"), description: t("settingsPage.aiModels.modes.localDesc"), icon: <Cpu className="w-4 h-4" /> },
    { id: "self-hosted", label: t("settingsPage.aiModels.modes.selfHosted"), description: t("settingsPage.aiModels.modes.selfHostedDesc"), icon: <Network className="w-4 h-4" /> },
  ] as InferenceModeOption[];
  const selectableModes = modes.filter((mode) => !allowedModes || allowedModes.includes(mode.id));
  const setField = useCallback(<K extends keyof Omit<typeof config, "scope">>(field: K) => (value: NonNullable<(typeof config)[K]>) => setResolvedLLMConfig(scope, { [field]: value }), [scope]);
  const handleModeSelect = (mode: InferenceMode) => { if (mode === config.mode) return; setResolvedLLMConfig(scope, { mode, cloudMode: "byok" }); onModeChange?.(mode); };
  const setProvider = setField("provider"); const setModel = setField("model"); const setMode = setField("mode");
  const showThinkingToggle = config.mode === "self-hosted" || (config.mode === "providers" && (config.provider === "custom" || config.provider === "openrouter" || !!getCloudModel(config.model)?.supportsThinking)) || (config.mode === "local" && !!getLocalModel(config.model)?.supportsThinking);
  return <div className="space-y-3">{selectableModes.length > 1 && <InferenceModeSelector modes={selectableModes} activeMode={config.mode} onSelect={handleModeSelect} />}{config.mode === "providers" && <ReasoningModelSelector reasoningModel={config.model} setReasoningModel={setModel} localReasoningProvider={config.provider} setLocalReasoningProvider={setProvider} cloudReasoningBaseUrl={config.cloudBaseUrl ?? ""} setCloudReasoningBaseUrl={setField("cloudBaseUrl")} customReasoningApiKey={config.customApiKey ?? ""} setCustomReasoningApiKey={setField("customApiKey")} setReasoningMode={setMode} mode="cloud" />}{config.mode === "local" && <ReasoningModelSelector reasoningModel={config.model} setReasoningModel={setModel} localReasoningProvider={config.provider} setLocalReasoningProvider={setProvider} cloudReasoningBaseUrl={config.cloudBaseUrl ?? ""} setCloudReasoningBaseUrl={setField("cloudBaseUrl")} customReasoningApiKey={config.customApiKey ?? ""} setCustomReasoningApiKey={setField("customApiKey")} setReasoningMode={setMode} mode="local" />}{config.mode === "self-hosted" && <OpenAICompatiblePanel baseUrl={config.remoteUrl ?? ""} setBaseUrl={setField("remoteUrl")} apiKey={config.customApiKey ?? ""} setApiKey={setField("customApiKey")} model={config.model} setModel={setModel} baseUrlPlaceholder="http://127.0.0.1:11434/v1" helpExamples={<p className="text-xs text-muted-foreground">{t("reasoning.selfHosted.endpointHelp")}</p>} />}{showThinkingToggle && <div className="flex items-start justify-between gap-3 pt-1"><div className="flex-1 min-w-0"><h4 className="text-sm font-medium text-foreground">{t("reasoning.disableThinking.label")}</h4><p className="text-xs text-muted-foreground">{t("reasoning.disableThinking.help")}</p></div><Toggle checked={config.disableThinking} onChange={setField("disableThinking")} /></div>}</div>;
}
