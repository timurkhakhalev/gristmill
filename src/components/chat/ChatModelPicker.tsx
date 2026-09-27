import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { useSettingsStore, setResolvedLLMConfig } from "../../stores/settingsStore";
import { selectResolvedLLMConfig } from "../../config/settingsSelectors";
import type { InferenceMode } from "../../contracts/inferenceSettings";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import BbAgentControls from "../settings/BbAgentControls";

export default function ChatModelPicker({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const modes: Array<{ id: InferenceMode; label: string }> = [
    { id: "providers", label: t("settingsPage.aiModels.modes.providers") },
    { id: "local", label: t("settingsPage.aiModels.modes.local") },
    { id: "self-hosted", label: t("settingsPage.aiModels.modes.selfHosted") },
    { id: "agent", label: t("bbAgent.mode") },
  ];
  const config = useSettingsStore(useShallow((state) => selectResolvedLLMConfig(state, "chatIntelligence")));
  const label = config.mode === "agent" ? `bb · ${config.agentModel || t("bbAgent.chooseModel")}` : config.model || modes.find((mode) => mode.id === config.mode)?.label;
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} aria-label={t("bbAgent.chatSettings")} className="max-w-44 truncate rounded-lg px-2 py-1 text-xs text-muted hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50">{label}</button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-64 space-y-3 p-3">
      <label className="block text-sm">{t("bbAgent.chatMode")}
        <select aria-label="Chat mode" disabled={disabled} className="mt-1 w-full rounded-lg border border-border bg-surface p-2" value={config.mode} onChange={(event) => setResolvedLLMConfig("chatIntelligence", { mode: event.target.value as InferenceMode })}>
          {modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
        </select>
      </label>
      {config.mode === "agent" ? <BbAgentControls scope="chatIntelligence" disabled={disabled} /> : <p className="text-xs text-muted">{t("bbAgent.otherSettings")}</p>}
    </PopoverContent>
  </Popover>;
}
