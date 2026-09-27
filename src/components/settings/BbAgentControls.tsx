import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore, setResolvedLLMConfig } from "../../stores/settingsStore";
import { selectResolvedLLMConfig } from "../../config/settingsSelectors";
import type { InferenceScope } from "../../config/inferenceScopes";
import type { BbModel, BbProvider } from "../../contracts/bb";

export default function BbAgentControls({ scope, disabled = false }: { scope: Extract<InferenceScope, "chatIntelligence" | "noteFormatting">; disabled?: boolean }) {
  const { t } = useTranslation();
  const config = useSettingsStore(useShallow((state) => selectResolvedLLMConfig(state, scope)));
  const [providers, setProviders] = useState<BbProvider[]>([]);
  const [models, setModels] = useState<BbModel[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    window.electronAPI.bbCatalog().then((items) => {
      if (!active) return;
      const available = items.filter((item) => item.available);
      setProviders(available);
      const current = selectResolvedLLMConfig(useSettingsStore.getState(), scope).agentProvider;
      if (!available.some((item) => item.id === current) && available[0]) {
        setResolvedLLMConfig(scope, { agentProvider: available[0].id, agentModel: "", agentReasoningLevel: "" });
      }
      setError(available.length ? "" : t("bbAgent.noHarness"));
    }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [scope, t]);

  useEffect(() => {
    if (!config.agentProvider) return;
    let active = true;
    window.electronAPI.bbModels(config.agentProvider).then((items) => {
      if (!active) return;
      setModels(items);
      const current = selectResolvedLLMConfig(useSettingsStore.getState(), scope);
      const model = items.find((item) => item.id === current.agentModel) ?? items[0];
      if (model) {
        const efforts = model.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [];
        const level = current.agentReasoningLevel && efforts.includes(current.agentReasoningLevel)
          ? current.agentReasoningLevel
          : model.defaultReasoningEffort ?? efforts[0] ?? "medium";
        if (model.id !== current.agentModel || level !== current.agentReasoningLevel) {
          setResolvedLLMConfig(scope, { agentModel: model.id, agentReasoningLevel: level });
        }
      }
      setError(items.length ? "" : t("bbAgent.noModel"));
    }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [scope, config.agentProvider, t]);

  const selectedProvider = providers.find((item) => item.id === config.agentProvider);
  const selectedModel = models.find((item) => item.id === config.agentModel);
  const modelLevels = selectedModel?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [];
  const levels = modelLevels.map((id) => ({ id, label: selectedProvider?.reasoningLevels?.find((item) => item.id === id)?.label ?? id }));

  return <div className="grid gap-2 text-sm">
    <label>{t("bbAgent.harness")}
      <select aria-label="bb harness" className="mt-1 w-full rounded-lg border border-border bg-surface p-2" disabled={disabled || !providers.length} value={config.agentProvider || ""} onChange={(event) => setResolvedLLMConfig(scope, { agentProvider: event.target.value, agentModel: "", agentReasoningLevel: "" })}>
        {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
      </select>
    </label>
    <label>{t("bbAgent.model")}
      <select aria-label="bb model" className="mt-1 w-full rounded-lg border border-border bg-surface p-2" disabled={disabled || !models.length} value={config.agentModel || ""} onChange={(event) => {
        const model = models.find((item) => item.id === event.target.value);
        setResolvedLLMConfig(scope, { agentModel: event.target.value, agentReasoningLevel: model?.defaultReasoningEffort ?? model?.supportedReasoningEfforts?.[0]?.reasoningEffort ?? "medium" });
      }}>
        {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
      </select>
    </label>
    <label>{t("bbAgent.reasoning")}
      <select aria-label="bb reasoning level" className="mt-1 w-full rounded-lg border border-border bg-surface p-2" disabled={disabled || !levels.length} value={config.agentReasoningLevel || ""} onChange={(event) => setResolvedLLMConfig(scope, { agentReasoningLevel: event.target.value })}>
        {levels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
      </select>
    </label>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
