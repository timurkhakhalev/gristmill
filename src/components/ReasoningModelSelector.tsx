import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  LlamaServerStatus,
  InferenceMode,
} from "../types/electron";
import { Cloud, Lock } from "./icons";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList from "./ui/ModelCardList";
import LocalModelPicker, { type LocalProvider } from "./LocalModelPicker";
import { ProviderTabs, type ProviderTabItem } from "./ui/ProviderTabs";
import OpenAICompatiblePanel from "./OpenAICompatiblePanel";
import { API_ENDPOINTS } from "../config/constants.mts";
import {
  REASONING_PROVIDERS,
  toReasoningModel,
  modelRegistry,
  isProviderValidForMode,
} from "../models/ModelRegistry";
import { useTinfoilModels } from "../hooks/useTinfoilModels";
import { getRemoteProviderIcon } from "../utils/providerIcons";
import { GetApiKeyLink } from "./ui/GetApiKeyLink";
import { useSettingsStore } from "../stores/settingsStore";

type CloudModelOption = {
  value: string;
  label: string;
  description?: string;
  descriptionKey?: string;
  icon?: string;
  ownedBy?: string;
  invertInDark?: boolean;
};

const OPENROUTER_TAB = "openrouter";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

const CLOUD_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  OPENROUTER_TAB,
  "tinfoil",
  "corti",
  "custom",
];

interface ReasoningModelSelectorProps {
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  localReasoningProvider: string;
  setLocalReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (value: string) => void;
  customReasoningApiKey?: string;
  setCustomReasoningApiKey?: (key: string) => void;
  setReasoningMode?: (mode: InferenceMode) => void;
  mode?: "cloud" | "local";
}

export default function ReasoningModelSelector({
  reasoningModel,
  setReasoningModel,
  localReasoningProvider,
  setLocalReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  customReasoningApiKey = "",
  setCustomReasoningApiKey,
  setReasoningMode: setReasoningModeProp,
  mode,
}: ReasoningModelSelectorProps) {
  const { t } = useTranslation();
  const openaiApiKey = useSettingsStore((s) => s.openaiApiKey);
  const setOpenaiApiKey = useSettingsStore((s) => s.setOpenaiApiKey);
  const anthropicApiKey = useSettingsStore((s) => s.anthropicApiKey);
  const setAnthropicApiKey = useSettingsStore((s) => s.setAnthropicApiKey);
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey);
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey);
  const groqApiKey = useSettingsStore((s) => s.groqApiKey);
  const setGroqApiKey = useSettingsStore((s) => s.setGroqApiKey);
  const openrouterApiKey = useSettingsStore((s) => s.openrouterApiKey);
  const setOpenrouterApiKey = useSettingsStore((s) => s.setOpenrouterApiKey);
  const tinfoilApiKey = useSettingsStore((s) => s.tinfoilApiKey);
  const setTinfoilApiKey = useSettingsStore((s) => s.setTinfoilApiKey);
  const cortiApiKey = useSettingsStore((s) => s.cortiApiKey);
  const setCortiApiKey = useSettingsStore((s) => s.setCortiApiKey);
  const [selectedMode, setSelectedMode] = useState<"cloud" | "local">(mode || "cloud");
  const [selectedCloudProvider, setSelectedCloudProvider] = useState("openai");
  const [selectedLocalProvider, setSelectedLocalProvider] = useState("qwen");
  const cloudProviderTabs = useMemo(
    () =>
      CLOUD_PROVIDER_IDS.map((id): ProviderTabItem => ({
        id,
        name:
          id === "custom"
            ? t("reasoning.custom.providerName")
            : id === OPENROUTER_TAB
              ? "OpenRouter"
              : REASONING_PROVIDERS[id as keyof typeof REASONING_PROVIDERS]?.name || id,
      })),
    [t]
  );
  const cloudProviders = cloudProviderTabs;
  const displayedCloudProvider = cloudProviderTabs.some((provider) => provider.id === selectedCloudProvider)
    ? selectedCloudProvider
    : cloudProviderTabs[0]?.id ?? "openai";
  const {
    models: tinfoilModels,
    loading: tinfoilModelsLoading,
    error: tinfoilModelsError,
  } = useTinfoilModels(displayedCloudProvider === "tinfoil");
  const modeTabs = [
    ...(cloudProviders.length > 0 ? [{ id: "cloud", name: t("reasoning.mode.cloud") }] : []),
    { id: "local", name: t("reasoning.mode.local") },
  ];
  const effectiveMode =
    mode ??
    (modeTabs.some((tab) => tab.id === selectedMode)
      ? selectedMode
      : (modeTabs[0]?.id as "cloud" | "local" | undefined));

  const localProviders = useMemo<LocalProvider[]>(() => {
    return modelRegistry.getAllProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        size: model.size,
        sizeBytes: model.sizeBytes,
        description: model.description,
        descriptionKey: model.descriptionKey,
        specUrl: model.hfRepo ? `https://huggingface.co/${model.hfRepo}` : undefined,
        recommended: model.recommended,
      })),
    }));
  }, []);

  const openaiModelOptions = useMemo<CloudModelOption[]>(() => {
    const { icon, invertInDark } = getRemoteProviderIcon("openai");
    return REASONING_PROVIDERS.openai.models.map((model) => ({
      ...model,
      description: model.descriptionKey
        ? t(model.descriptionKey, { defaultValue: model.description })
        : model.description,
      icon,
      invertInDark,
    }));
  }, [t]);

  const selectedCloudModels = useMemo<CloudModelOption[]>(() => {
    if (displayedCloudProvider === "openai") return openaiModelOptions;
    if (displayedCloudProvider === "custom" || displayedCloudProvider === OPENROUTER_TAB) return [];

    const { icon: iconUrl, invertInDark } = getRemoteProviderIcon(displayedCloudProvider);

    const models =
      displayedCloudProvider === "tinfoil"
        ? tinfoilModels.map(toReasoningModel)
        : REASONING_PROVIDERS[displayedCloudProvider as keyof typeof REASONING_PROVIDERS]?.models;

    if (!models) return [];

    return models.map((model) => ({
      ...model,
      description: model.descriptionKey
        ? t(model.descriptionKey, { defaultValue: model.description })
        : model.description,
      icon: iconUrl,
      invertInDark,
    }));
  }, [displayedCloudProvider, openaiModelOptions, tinfoilModels, t]);

  useEffect(() => {
    const localProviderIds = localProviders.map((p) => p.id);
    if (localProviderIds.includes(localReasoningProvider)) {
      setSelectedMode("local");
      setSelectedLocalProvider(localReasoningProvider);
    } else if (CLOUD_PROVIDER_IDS.includes(localReasoningProvider)) {
      setSelectedMode("cloud");
      setSelectedCloudProvider(localReasoningProvider);
    }
  }, [localProviders, localReasoningProvider]);

  // A selection commits only on an explicit click: the model together with
  // the provider tab it was clicked under. Tab switching is pure browsing.
  // Local models resolve their provider from the registry so an async select
  // (e.g. a download finishing while another tab is browsed) can never commit
  // a mismatched (provider, model) pair.
  const handleModelSelect = (modelId: string) => {
    if (!modelId) {
      setReasoningModel("");
      return;
    }
    const provider =
      effectiveMode === "local"
        ? (modelRegistry.getModel(modelId)?.provider.id ?? selectedLocalProvider)
        : displayedCloudProvider;
    setLocalReasoningProvider(provider);
    setReasoningModel(modelId);
  };

  const handleModeChange = (newMode: "cloud" | "local") => {
    if (newMode === "cloud" && cloudProviders.length === 0) return;
    setSelectedMode(newMode);
    const inferenceMode: InferenceMode = newMode === "local" ? "local" : "providers";
    setReasoningModeProp?.(inferenceMode);
    if (!isProviderValidForMode(localReasoningProvider, inferenceMode)) {
      setLocalReasoningProvider("");
      setReasoningModel("");
    }

    if (newMode === "cloud") {
      window.electronAPI?.llamaServerStop?.();
    }
  };

  const handleCloudProviderChange = (provider: string) => {
    setSelectedCloudProvider(provider);
  };

  const handleLocalProviderChange = (providerId: string) => {
    setSelectedLocalProvider(providerId);
  };

  const renderModeIcon = (id: string) => {
    if (id === "cloud") return <Cloud className="w-4 h-4" />;
    return <Lock className="w-4 h-4" />;
  };

  return (
    <div className="space-y-4">
      {!mode && (
        <div className="space-y-2">
          <>
            <ProviderTabs
              providers={modeTabs}
              selectedId={effectiveMode}
              onSelect={(id) => handleModeChange(id as "cloud" | "local")}
              renderIcon={renderModeIcon}
              colorScheme="purple"
            />
            <p className="text-xs text-muted-foreground text-center">
              {effectiveMode === "local"
                ? t("reasoning.mode.localDescription")
                : t("reasoning.mode.cloudDescription")}
            </p>
          </>
        </div>
      )}

      {effectiveMode === "cloud" && (
        <div className="space-y-2">
          {cloudProviderTabs.length > 0 && (
            <ProviderTabs
              providers={cloudProviderTabs}
              selectedId={displayedCloudProvider}
              onSelect={handleCloudProviderChange}
              colorScheme="purple"
              wrap
            />
          )}

          <div>
              {/* A model renders as selected only under its committed provider —
                free-form custom/OpenRouter ids can collide with registry ids. */}
              {displayedCloudProvider === OPENROUTER_TAB ? (
                <OpenAICompatiblePanel
                  key={OPENROUTER_TAB}
                  baseUrl={API_ENDPOINTS.OPENROUTER_BASE}
                  setBaseUrl={() => {}}
                  apiKey={openrouterApiKey}
                  setApiKey={setOpenrouterApiKey}
                  model={localReasoningProvider === OPENROUTER_TAB ? reasoningModel : ""}
                  setModel={(m) => {
                    setLocalReasoningProvider(OPENROUTER_TAB);
                    setReasoningModel(m);
                  }}
                  lockedBaseUrl
                  apiKeyRequired
                  getKeyUrl={OPENROUTER_KEYS_URL}
                />
              ) : displayedCloudProvider === "custom" ? (
                <OpenAICompatiblePanel
                  key="custom"
                  baseUrl={cloudReasoningBaseUrl}
                  setBaseUrl={setCloudReasoningBaseUrl}
                  apiKey={customReasoningApiKey}
                  setApiKey={setCustomReasoningApiKey || (() => {})}
                  model={localReasoningProvider === "custom" ? reasoningModel : ""}
                  setModel={(m) => {
                    setLocalReasoningProvider("custom");
                    setReasoningModel(m);
                  }}
                  defaultBaseUrl={API_ENDPOINTS.OPENAI_BASE}
                />
              ) : (
                <>
                  {displayedCloudProvider === "openai" && (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <GetApiKeyLink url="https://platform.openai.com/api-keys" />
                      </div>
                      <ApiKeyInput
                        apiKey={openaiApiKey}
                        setApiKey={setOpenaiApiKey}
                        label=""
                        helpText=""
                      />
                    </div>
                  )}

                  {displayedCloudProvider === "anthropic" && (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <GetApiKeyLink url="https://console.anthropic.com/settings/keys" />
                      </div>
                      <ApiKeyInput
                        apiKey={anthropicApiKey}
                        setApiKey={setAnthropicApiKey}
                        label=""
                        helpText=""
                      />
                    </div>
                  )}

                  {displayedCloudProvider === "gemini" && (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <GetApiKeyLink url="https://aistudio.google.com/app/api-keys" />
                      </div>
                      <ApiKeyInput
                        apiKey={geminiApiKey}
                        setApiKey={setGeminiApiKey}
                        label=""
                        helpText=""
                      />
                    </div>
                  )}

                  {displayedCloudProvider === "groq" && (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <GetApiKeyLink url="https://console.groq.com/keys" />
                      </div>
                      <ApiKeyInput
                        apiKey={groqApiKey}
                        setApiKey={setGroqApiKey}
                        label=""
                        helpText=""
                      />
                    </div>
                  )}

                  {displayedCloudProvider === "tinfoil" && (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <GetApiKeyLink url="https://tinfoil.sh/inference?utm_source=referral&utm_campaign=openhercules" />
                      </div>
                      <ApiKeyInput
                        apiKey={tinfoilApiKey}
                        setApiKey={setTinfoilApiKey}
                        label=""
                        helpText=""
                      />
                    </div>
                  )}

                  {displayedCloudProvider === "corti" && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">{t("reasoning.corti.euOnly")}</p>
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <GetApiKeyLink url="https://www.corti.ai/?utm_source=referral&utm_campaign=openhercules" />
                      </div>
                      <ApiKeyInput
                        apiKey={cortiApiKey}
                        setApiKey={setCortiApiKey}
                        label=""
                        helpText=""
                      />
                    </div>
                  )}

                  <div className="pt-3 space-y-2">
                    <h4 className="text-sm font-medium text-foreground">
                      {t("reasoning.selectModel")}
                    </h4>
                    <ModelCardList
                      models={selectedCloudModels}
                      selectedModel={
                        localReasoningProvider === displayedCloudProvider ? reasoningModel : ""
                      }
                      onModelSelect={handleModelSelect}
                    />
                    {displayedCloudProvider === "tinfoil" && (
                      <>
                        {tinfoilModelsLoading && (
                          <p className="text-xs text-muted-foreground">
                            {t("reasoning.tinfoil.refreshingModels")}
                          </p>
                        )}
                        {!tinfoilModelsLoading && tinfoilModelsError && (
                          <p className="text-xs text-destructive">
                            {t("reasoning.custom.unableToLoadModels")}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
          </div>
        </div>
      )}

      {effectiveMode === "local" && (
        <>
          <LocalModelPicker
            providers={localProviders}
            selectedModel={reasoningModel}
            selectedProvider={selectedLocalProvider}
            onModelSelect={handleModelSelect}
            onProviderSelect={handleLocalProviderChange}
            modelType="llm"
            colorScheme="purple"
          />
        </>
      )}
    </div>
  );
}
