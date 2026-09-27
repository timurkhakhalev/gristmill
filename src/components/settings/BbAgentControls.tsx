import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore, setResolvedLLMConfig } from "../../stores/settingsStore";
import { selectResolvedLLMConfig } from "../../config/settingsSelectors";
import type { InferenceScope } from "../../config/inferenceScopes";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { ChevronDown } from "../icons";
import { BbModelPanel } from "../bb/BbModelPanel";
import { BbSelectionLabel } from "../bb/BbSelectionLabel";
import { useBbCatalog } from "../bb/useBbCatalog";

/** Per-scope bb selection: follow the app-wide default harness or pin one for this scope. */
export default function BbAgentControls({ scope }: { scope: Extract<InferenceScope, "chatIntelligence" | "noteFormatting"> }) {
  const { t } = useTranslation();
  const config = useSettingsStore(useShallow((state) => selectResolvedLLMConfig(state, scope)));
  const { enabled, error } = useBbCatalog();
  const harness = enabled.find((item) => item.id === config.agentProvider);
  const usesDefault = config.agentUsesDefault !== false;
  const selection = config.agentProvider
    ? { provider: config.agentProvider, model: config.agentModel ?? "", reasoningLevel: config.agentReasoningLevel ?? "" }
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">{t("bbAgent.useDefault")}</h4>
          <p className="text-xs text-muted-foreground">{t("bbAgent.useDefaultHelp")}</p>
        </div>
        <Toggle
          checked={usesDefault}
          onChange={(value) => setResolvedLLMConfig(scope, value
            ? { agentProvider: "", agentModel: "", agentReasoningLevel: "" }
            : { agentProvider: selection?.provider, agentModel: selection?.model, agentReasoningLevel: selection?.reasoningLevel })}
        />
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={usesDefault}
            aria-label={t("bbAgent.model")}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
          >
            <BbSelectionLabel harness={harness} model={config.agentModel ?? ""} reasoningLevel={config.agentReasoningLevel ?? ""} />
            <ChevronDown size={14} className="shrink-0 text-muted" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="p-2">
          <BbModelPanel
            harnesses={enabled}
            selection={selection}
            onSelect={(next) => setResolvedLLMConfig(scope, { agentProvider: next.provider, agentModel: next.model, agentReasoningLevel: next.reasoningLevel })}
          />
        </PopoverContent>
      </Popover>
      {!config.agentProvider && <p role="alert" className="text-xs text-danger">{t("bbAgent.noSelection")}</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}
