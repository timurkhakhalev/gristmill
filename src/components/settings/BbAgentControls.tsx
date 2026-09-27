import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore, setResolvedLLMConfig } from "../../stores/settingsStore";
import { selectResolvedLLMConfig } from "../../config/settingsSelectors";
import type { InferenceScope } from "../../config/inferenceScopes";
import type { BbModel, BbProvider } from "../../contracts/bb";

export default function BbAgentControls({ scope, disabled = false }: { scope: Extract<InferenceScope, "chatIntelligence" | "noteFormatting">; disabled?: boolean }) {
  const config = useSettingsStore(useShallow((state) => selectResolvedLLMConfig(state, scope)));
  const [providers, setProviders] = useState<BbProvider[]>([]);
  const [models, setModels] = useState<BbModel[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    window.electronAPI.bbCatalog().then((items) => {
      if (active) { setProviders(items.filter((item) => item.available)); setError(""); }
    }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!config.agentProvider) return;
    let active = true;
    window.electronAPI.bbModels(config.agentProvider).then((items) => {
      if (!active) return;
      setModels(items);
      if (!items.some((item) => item.id === config.agentModel) && items[0]) {
        setResolvedLLMConfig(scope, { agentModel: items[0].id });
      }
      setError("");
    }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [scope, config.agentProvider, config.agentModel]);

  const selectedProvider = providers.find((item) => item.id === config.agentProvider);
  const selectedModel = models.find((item) => item.id === config.agentModel);
  const modelLevels = selectedModel?.supportedReasoningEfforts?.map((item) => item.reasoningEffort);
  const levels = (selectedProvider?.reasoningLevels ?? []).filter((item) => !modelLevels || modelLevels.includes(item.id));

  return <div className="grid gap-2 text-sm">
    <label>Harness
      <select aria-label="bb harness" className="mt-1 w-full rounded-lg border border-border bg-surface p-2" disabled={disabled} value={config.agentProvider || ""} onChange={(event) => setResolvedLLMConfig(scope, { agentProvider: event.target.value, agentModel: "" })}>
        {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
      </select>
    </label>
    <label>Model
      <select aria-label="bb model" className="mt-1 w-full rounded-lg border border-border bg-surface p-2" disabled={disabled} value={config.agentModel || ""} onChange={(event) => setResolvedLLMConfig(scope, { agentModel: event.target.value })}>
        {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
      </select>
    </label>
    <label>Reasoning
      <select aria-label="bb reasoning level" className="mt-1 w-full rounded-lg border border-border bg-surface p-2" disabled={disabled} value={config.agentReasoningLevel || "medium"} onChange={(event) => setResolvedLLMConfig(scope, { agentReasoningLevel: event.target.value })}>
        {levels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
      </select>
    </label>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
