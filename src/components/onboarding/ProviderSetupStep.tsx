import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, CircleCheck } from "../icons";
import { useTranslation } from "react-i18next";
import ProviderConnectionTest from "./ProviderConnectionTest";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderIcon } from "../ui/ProviderIcon";
import { SelectField } from "../ui/SelectField";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  getTranscriptionProviders,
  type TranscriptionProviderData,
} from "../../models/ModelRegistry";
import { pickDefaultModelId } from "../../models/providerDefaultModel";
import { resolveTranscriptionRoute } from "../../helpers/transcriptionRoute";
import type { OnboardingByokDraft } from "./flow";

type HostedProvider = TranscriptionProviderData;

export function SetupStageStepper() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex items-center gap-2 text-xs text-[var(--onboarding-text-secondary)]">
      <CircleCheck className="size-4 text-[var(--onboarding-accent)]" />
      <span>{t("onboarding.rehaul.provider.title")}</span>
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1.5 block text-xs text-[var(--onboarding-text-tertiary)]">{children}</span>
  );
}

const providerCredential = (
  provider: string,
  store: ReturnType<typeof useSettingsStore.getState>
) => {
  switch (provider) {
    case "openai":
      return { value: store.openaiApiKey, set: store.setOpenaiApiKey };
    case "gemini":
      return { value: store.geminiApiKey, set: store.setGeminiApiKey };
    case "groq":
      return { value: store.groqApiKey, set: store.setGroqApiKey };
    case "xai":
      return { value: store.xaiApiKey, set: store.setXaiApiKey };
    case "mistral":
      return { value: store.mistralApiKey, set: store.setMistralApiKey };
    case "tinfoil":
      return { value: store.tinfoilApiKey, set: store.setTinfoilApiKey };
    case "deepgram":
      return { value: store.deepgramApiKey, set: store.setDeepgramApiKey };
    case "elevenlabs":
      return { value: store.elevenLabsApiKey, set: store.setElevenLabsApiKey };
    default:
      return null;
  }
};

interface ByokProviderStepProps {
  selfHostedRequested?: boolean;
  onSelfHostedChange?: (requested: boolean) => void;
  onConnectionChange: (connected: boolean) => void;
  onProceed: () => void;
  /** The footer's Continue runs the same confirmed save-then-proceed transition. */
  onFooterContinue?: (commitAndProceed: () => Promise<void>, isSaving: boolean) => void;
  resumeState?: OnboardingByokDraft;
  onResumeStateChange?: (state: OnboardingByokDraft) => void;
}

/** Configure the transcription provider used by Notes and uploads. */
export function ByokProviderStep({
  selfHostedRequested = false,
  onSelfHostedChange = () => {},
  onConnectionChange,
  onProceed,
  onFooterContinue,
  resumeState,
  onResumeStateChange,
}: ByokProviderStepProps) {
  const { t } = useTranslation();
  const store = useSettingsStore();

  const providers = useMemo<HostedProvider[]>(() => {
    const catalog = getTranscriptionProviders();

    return catalog
      .filter((provider) => providerCredential(provider.id, useSettingsStore.getState()) !== null)
      .map((provider) => ({
        ...provider,
        models: provider.models.filter(
          (model) =>
            resolveTranscriptionRoute({
              providers: catalog,
              settings: {
                transcriptionMode: "providers",
                cloudTranscriptionProvider: provider.id,
                cloudTranscriptionModel: model.id,
              },
            }).transport !== "error"
        ),
      }))
      .filter((provider) => provider.models.length > 0);
  }, []);

  const initialProvider =
    providers.find((item) => item.id === resumeState?.selectedProvider)?.id ??
    providers.find((item) => item.id === store.cloudTranscriptionProvider)?.id ??
    "";

  const [selfHosted, setSelfHosted] = useState(selfHostedRequested);
  const [selectedProvider, setSelectedProvider] = useState(initialProvider);

  const [selectedModel, setSelectedModel] = useState(() => {
    const provider = providers.find((item) => item.id === initialProvider);

    return (
      provider?.models.find((model) => model.id === resumeState?.selectedModel)?.id ??
      provider?.models.find((model) => model.id === store.cloudTranscriptionModel)?.id ??
      pickDefaultModelId(provider)
    );
  });

  const [draftApiKey, setDraftApiKey] = useState(
    () => providerCredential(initialProvider, store)?.value ?? ""
  );

  const [draftBaseUrl, setDraftBaseUrl] = useState(resumeState?.baseUrl ?? "");
  const [draftCustomModel, setDraftCustomModel] = useState(resumeState?.customModel ?? "");
  const [connected, setConnected] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const latestDraft = useRef<OnboardingByokDraft | null>(null);
  const saveGeneration = useRef(0);
  const saveInFlight = useRef(false);
  const mounted = useRef(true);

  const invalidateSave = useCallback(() => {
    saveGeneration.current++;
  }, []);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  // Stable identity: ProviderConnectionTest resets on onSuccessChange identity,
  // so a fresh inline callback per render cancelled the success it reported
  // (issue #180).
  const handleSuccessChange = useCallback(
    (success: boolean) => {
      setConnected(success);
      onConnectionChange(success);
    },
    [onConnectionChange]
  );

  useEffect(() => {
    onConnectionChange(false);
  }, [onConnectionChange]);

  useEffect(() => {
    latestDraft.current = {
      selectedProvider,
      selectedModel,
      baseUrl: draftBaseUrl,
      customModel: draftCustomModel,
    };
  }, [draftBaseUrl, draftCustomModel, selectedModel, selectedProvider]);

  useEffect(
    () => () => {
      if (latestDraft.current) onResumeStateChange?.(latestDraft.current);
    },
    [onResumeStateChange]
  );

  const currentProvider = providers.find((provider) => provider.id === selectedProvider);
  const models = currentProvider?.models ?? [];
  const testingProvider = selfHosted ? "custom" : selectedProvider;

  const fieldsReady = selfHosted
    ? Boolean(draftBaseUrl.trim() && draftCustomModel.trim())
    : Boolean(selectedProvider && selectedModel && draftApiKey.trim());

  const chooseProvider = useCallback(
    (providerId: string) => {
      invalidateSave();
      setSelectedProvider(providerId);
      setSelectedModel(pickDefaultModelId(providers.find((item) => item.id === providerId)));
      setDraftApiKey(providerCredential(providerId, store)?.value ?? "");
      setSaveError(false);
      setConnected(false);
      onConnectionChange(false);
    },
    [invalidateSave, onConnectionChange, providers, store]
  );

  const commitAndProceed = useCallback(async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    const generation = ++saveGeneration.current;
    const isCurrent = () => mounted.current && saveGeneration.current === generation;
    setIsSaving(true);
    setSaveError(false);

    try {
      const result = selfHosted
        ? await store.setCustomTranscriptionApiKey(draftApiKey)
        : await providerCredential(selectedProvider, store)?.set(draftApiKey);

      if (!isCurrent()) return;

      if (result?.success !== true) {
        setSaveError(true);

        return;
      }

      if (selfHosted) {
        const url = draftBaseUrl.includes("://")
          ? draftBaseUrl.trim()
          : `https://${draftBaseUrl.trim()}`;

        store.setRemoteTranscriptionUrl("");
        store.setMeetingRemoteTranscriptionUrl("");
        store.setCloudTranscriptionForAllScopes({
          useLocalWhisper: false,
          cloudTranscriptionBaseUrl: url,
          cloudTranscriptionModel: draftCustomModel,
          cloudTranscriptionProvider: "custom",
          cloudTranscriptionMode: "byok",
        });
      } else {
        store.setCloudTranscriptionForAllScopes({
          useLocalWhisper: false,
          cloudTranscriptionBaseUrl: "",
          cloudTranscriptionMode: "byok",
          cloudTranscriptionProvider: selectedProvider,
          cloudTranscriptionModel: selectedModel,
        });
      }

      onProceed();
    } catch {
      if (isCurrent()) setSaveError(true);
    } finally {
      saveInFlight.current = false;

      if (mounted.current) setIsSaving(false);
    }
  }, [
    draftApiKey,
    draftBaseUrl,
    draftCustomModel,
    onProceed,
    selectedModel,
    selectedProvider,
    selfHosted,
    store,
  ]);

  // Publish footer state after render; duplicate clicks are guarded synchronously.
  useEffect(() => {
    onFooterContinue?.(commitAndProceed, isSaving);
  }, [commitAndProceed, isSaving, onFooterContinue]);

  return (
    <section className="mx-auto mt-5 w-full max-w-[30rem] rounded-[1.125rem] border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-3 py-4">
      <SetupStageStepper />
      <div className="mt-3 space-y-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={selfHosted}
          onClick={() => {
            invalidateSave();
            const next = !selfHosted;
            setSelfHosted(next);
            onSelfHostedChange(next);
            setConnected(false);
            onConnectionChange(false);
          }}
          className="flex items-center gap-2 text-xs text-[var(--onboarding-text-primary)]"
        >
          <span
            className={`flex size-5 items-center justify-center rounded border border-[var(--onboarding-control-border)] ${selfHosted ? "bg-[var(--onboarding-accent)]" : ""}`}
          >
            {selfHosted && (
              <Check className="size-3.5 text-[var(--onboarding-accent-foreground)]" />
            )}
          </span>
          {t("onboarding.rehaul.provider.selfHosted")}
        </button>

        {selfHosted ? (
          <>
            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.endpointUrl")}</FieldLabel>
              <Input
                dir="ltr"
                value={draftBaseUrl}
                onChange={(event) => {
                  invalidateSave();
                  setDraftBaseUrl(event.target.value);
                }}
                placeholder={t("onboarding.rehaul.provider.endpointPlaceholder")}
              />
            </label>
            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.modelId")}</FieldLabel>
              <Input
                dir="ltr"
                value={draftCustomModel}
                onChange={(event) => {
                  invalidateSave();
                  setDraftCustomModel(event.target.value);
                }}
                placeholder={t("onboarding.rehaul.provider.modelIdPlaceholder")}
              />
            </label>
            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.apiKey")}</FieldLabel>
              <Input
                dir="ltr"
                type="password"
                value={draftApiKey}
                onChange={(event) => {
                  invalidateSave();
                  setDraftApiKey(event.target.value);
                  setSaveError(false);
                }}
                placeholder={t("onboarding.rehaul.provider.optional")}
              />
            </label>
          </>
        ) : (
          <>
            <div>
              <FieldLabel>{t("onboarding.rehaul.provider.providerLabel")}</FieldLabel>
              <SelectField
                value={selectedProvider}
                onChange={chooseProvider}
                ariaLabel={t("onboarding.rehaul.provider.providerLabel")}
                placeholder={t("onboarding.rehaul.provider.providerPlaceholder")}
                className="w-full"
                options={providers.map((provider) => ({
                  id: provider.id,
                  label: provider.name,
                  icon: <ProviderIcon provider={provider.id} className="size-4" />,
                }))}
              />
            </div>
            <div>
              <FieldLabel>{t("onboarding.rehaul.provider.modelLabel")}</FieldLabel>
              <SelectField
                value={selectedModel}
                onChange={(value) => {
                  invalidateSave();
                  setSelectedModel(value);
                  setConnected(false);
                  onConnectionChange(false);
                }}
                isDisabled={!selectedProvider}
                dir="ltr"
                ariaLabel={t("onboarding.rehaul.provider.modelLabel")}
                placeholder={t("onboarding.rehaul.provider.modelPlaceholder")}
                className="w-full"
                options={models.map((model) => ({ id: model.id, label: model.name }))}
              />
            </div>
            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.apiKey")}</FieldLabel>
              <Input
                dir="ltr"
                type="password"
                value={draftApiKey}
                onChange={(event) => {
                  invalidateSave();
                  setDraftApiKey(event.target.value);
                  setSaveError(false);
                  setConnected(false);
                  onConnectionChange(false);
                }}
                disabled={!selectedProvider}
              />
            </label>
          </>
        )}

        <ProviderConnectionTest
          config={{
            provider: testingProvider,
            apiKey: draftApiKey,
            baseUrl: selfHosted ? draftBaseUrl : undefined,
            model: selfHosted ? draftCustomModel : selectedModel,
            scope: "transcription",
          }}
          onSuccessChange={handleSuccessChange}
          variant="inline"
        />
        {saveError && (
          <p role="alert" className="text-xs text-destructive">
            {t("apiKeyInput.saveError", {
              defaultValue: "Could not save securely. Check secure storage and try again.",
            })}
          </p>
        )}
        <Button
          type="button"
          onClick={() => {
            commitAndProceed().catch(() => {});
          }}
          disabled={!connected || !fieldsReady || isSaving}
          className="mt-4 w-full"
        >
          {t("onboarding.rehaul.provider.proceed")}
        </Button>
      </div>
    </section>
  );
}
