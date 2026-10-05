import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { useSettingsStore, setResolvedLLMConfig } from "../../stores/settingsStore";
import { selectResolvedLLMConfig } from "../../config/settingsSelectors";
import type { InferenceMode } from "../../contracts/inferenceSettings";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ChevronDown, Key } from "../icons";
import { cn } from "../lib/utils";
import { BbModelPanel } from "../bb/BbModelPanel";
import { BbSelectionLabel } from "../bb/BbSelectionLabel";
import { useBbCatalog } from "../bb/useBbCatalog";

// The API route the chat returns to from bb; remembered so switching back keeps it.
const LAST_API_MODE_KEY = "chatAgentLastApiMode";

function lastApiMode(): InferenceMode {
  const stored = localStorage.getItem(LAST_API_MODE_KEY);

  return stored === "local" || stored === "self-hosted" || stored === "enterprise"
    ? stored
    : "providers";
}

/** Composer model picker: bb harness tabs plus an "API" tab for the configured non-bb route. */
export default function ChatModelPicker({
  disabled,
  className,
  onOpenChange,
}: {
  disabled?: boolean;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  const config = useSettingsStore(
    useShallow((state) => selectResolvedLLMConfig(state, "chatIntelligence"))
  );

  const { enabled, error } = useBbCatalog();
  const isBb = config.mode === "agent";
  const harness = enabled.find((item) => item.id === config.agentProvider);

  const modeLabels: Partial<Record<InferenceMode, string>> = {
    providers: t("settingsPage.aiModels.modes.providers"),
    local: t("settingsPage.aiModels.modes.local"),
    "self-hosted": t("settingsPage.aiModels.modes.selfHosted"),
  };

  const apiMode = isBb ? lastApiMode() : config.mode;
  const apiLabel = modeLabels[apiMode] ?? apiMode;

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t("bbAgent.chatSettings")}
          className={cn(
            "flex h-7 max-w-52 min-w-0 shrink items-center gap-1 rounded-full px-2 text-xs text-muted outline-none transition-colors",
            "hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50",
            className
          )}
        >
          {isBb ? (
            <BbSelectionLabel
              harness={harness}
              model={config.agentModel ?? ""}
              reasoningLevel={config.agentReasoningLevel ?? ""}
            />
          ) : (
            <span className="flex min-w-0 items-center gap-1.5">
              <Key size={13} className="shrink-0" />
              <span className="truncate">{config.model || apiLabel}</span>
            </span>
          )}
          <ChevronDown size={12} className="shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="p-2">
        <BbModelPanel
          harnesses={enabled}
          selection={
            isBb && config.agentProvider
              ? {
                  provider: config.agentProvider,
                  model: config.agentModel ?? "",
                  reasoningLevel: config.agentReasoningLevel ?? "",
                }
              : null
          }
          onSelect={(selection) => {
            if (!isBb) localStorage.setItem(LAST_API_MODE_KEY, config.mode);
            setResolvedLLMConfig("chatIntelligence", {
              mode: "agent",
              agentProvider: selection.provider,
              agentModel: selection.model,
              agentReasoningLevel: selection.reasoningLevel,
            });
          }}
          leadingTabs={[
            {
              id: "api",
              label: t("bbAgent.apiTab"),
              icon: <Key size={14} />,
              active: !isBb,
              onSelect: () => {
                if (isBb) setResolvedLLMConfig("chatIntelligence", { mode: apiMode });
              },
            },
          ]}
          leadingContent={
            <p className="px-1 py-3 text-xs text-muted">
              {t("bbAgent.apiRoute", {
                route: config.model ? `${apiLabel} · ${config.model}` : apiLabel,
              })}
            </p>
          }
        />
        {error && (
          <p role="alert" className="px-1 pt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
