import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore, setResolvedLLMConfig } from "../../../stores/settingsStore";
import { selectResolvedLLMConfig } from "../../../config/settingsSelectors";
import { API_ENDPOINTS, normalizeBaseUrl } from "../../../config/constants.mts";
import { getCloudModel, getLocalModel, getTranscriptionProviders } from "../../../models/ModelRegistry";
import { useTinfoilModels } from "../../../hooks/useTinfoilModels";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { Toggle } from "../../ui/toggle";
import { Input } from "../../ui/input";
import ApiKeyInput from "../../ui/ApiKeyInput";
import OpenAICompatiblePanel from "../../OpenAICompatiblePanel";
import { AlertCircle, ArrowLeft, Check, ChevronDown, ChevronRight, Download, Network, Search, X } from "../../icons";
import { cn } from "../../lib/utils";
import { HarnessIcon } from "../../bb/HarnessIcon";
import { BbModelPanel } from "../../bb/BbModelPanel";
import { BbSelectionLabel } from "../../bb/BbSelectionLabel";
import { useBbCatalog } from "../../bb/useBbCatalog";
import { useLocalModelInventory, type LocalModelEntry } from "./inventoryContext";
import { findProvider, isProviderReady } from "./providerDirectory";
import { ProviderCredentialsForm } from "./ProviderCredentialsForm";
import { useCredentialValues } from "./useCredentialValues";
import { cloudGroups, cloudModelName, cloudProviderName, localGroups, matchesQuery, type CatalogGroup } from "./taskCatalog";
import {
  isSpeechTask,
  selectBb,
  selectCloudModel,
  selectLocalModel,
  selectSelfHosted,
  taskSources,
  useTaskSelection,
  type LanguageTask,
  type ModelSource,
  type ModelTask,
  type TaskSelection,
} from "./taskModels";

const capabilityOf = (task: ModelTask) => (isSpeechTask(task) ? "speech" : "language");

/** What the trigger shows for the current choice, including why it cannot run yet. */
function useSelectionSummary(task: ModelTask, selection: TaskSelection) {
  const { t } = useTranslation();
  const inventory = useLocalModelInventory();
  const credentials = useCredentialValues();
  const sourceLabel = t(`modelsSettings.sources.${selection.source}`);

  if (selection.source === "local") {
    const entry = inventory.find(isSpeechTask(task) ? "speech" : "language", selection.modelId);
    return {
      icon: <ProviderIcon provider={entry?.organization ?? selection.providerId} className="size-4" />,
      name: entry?.name ?? (selection.modelId || t("modelsSettings.status.chooseModel")),
      detail: sourceLabel,
      problem: !selection.modelId
        ? undefined
        : entry?.unavailableReason ?? (entry?.downloaded ? undefined : t("modelsSettings.status.notDownloaded")),
    };
  }
  if (selection.source === "self-hosted") {
    return {
      icon: <Network className="size-4" />,
      name: selection.modelId || selection.endpoint || t("modelsSettings.sources.self-hosted"),
      detail: selection.endpoint || sourceLabel,
      problem: !selection.endpoint
        ? t("modelsSettings.status.needsEndpoint")
        : !isSpeechTask(task) && !selection.modelId ? t("modelsSettings.status.chooseModel") : undefined,
    };
  }
  if (selection.source === "enterprise") {
    return { icon: <ProviderIcon provider={selection.providerId} className="size-4" />, name: selection.modelId, detail: sourceLabel, problem: undefined };
  }
  const entry = findProvider(selection.providerId);
  const needsKey = entry && !isProviderReady(entry, capabilityOf(task), credentials);
  return {
    icon: <ProviderIcon provider={selection.providerId} className="size-4" />,
    name: selection.modelId ? cloudModelName(task, selection.providerId, selection.modelId) : t("modelsSettings.status.chooseModel"),
    detail: cloudProviderName(task, selection.providerId, t),
    problem: !selection.modelId
      ? undefined
      : needsKey
        ? t("modelsSettings.status.needsKey")
        : selection.providerId === "custom" && !selection.endpoint ? t("modelsSettings.status.needsEndpoint") : undefined,
  };
}

function BbTrigger({ selection }: { selection: TaskSelection }) {
  const { t } = useTranslation();
  const { enabled } = useBbCatalog();
  const harness = enabled.find((item) => item.id === selection.providerId);
  const problem = !harness || !selection.modelId ? t("modelsSettings.status.noHarness") : undefined;
  return (
    <TriggerBody
      icon={harness ? <HarnessIcon logo={harness.logo} /> : <AlertCircle className="size-4" />}
      name={<BbSelectionLabel harness={harness} model={selection.modelId} reasoningLevel={selection.reasoningLevel ?? ""} hideIcon />}
      detail={selection.followsDefault ? t("modelsSettings.picker.bbDefault") : "bb"}
      problem={problem}
    />
  );
}

function TriggerBody({ icon, name, detail, problem, placeholder = false }: { icon: ReactNode; name: ReactNode; detail: ReactNode; problem?: string; placeholder?: boolean }) {
  return (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-foreground">{icon}</span>
      <span className="min-w-0 flex-1 text-start">
        <span className={cn("block truncate text-sm", placeholder ? "text-muted-foreground" : "text-foreground")}>{name}</span>
        <span className={cn("flex items-center gap-1 truncate text-xs", problem ? "text-warning" : "text-muted-foreground")}>
          {problem && <AlertCircle size={12} className="shrink-0" />}
          <span className="truncate">{problem ?? detail}</span>
        </span>
      </span>
    </>
  );
}

function SummaryTrigger({ task, selection }: { task: ModelTask; selection: TaskSelection }) {
  const summary = useSelectionSummary(task, selection);
  return <TriggerBody icon={summary.icon} name={summary.name} detail={summary.detail} problem={summary.problem} placeholder={!selection.modelId && selection.source !== "self-hosted"} />;
}

/** A task's model control: a summary button that opens the source picker. */
export function TaskModelControl({ task, label }: { task: ModelTask; label: string }) {
  const selection = useTaskSelection(task);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="flex h-11 w-72 max-w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-2 outline-none transition-colors hover:border-border-hover hover:bg-default/40 focus-visible:ring-2 focus-visible:ring-focus"
        >
          {selection.source === "bb" ? <BbTrigger selection={selection} /> : <SummaryTrigger task={task} selection={selection} />}
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-0">
        <TaskModelPanel task={task} selection={selection} />
      </PopoverContent>
    </Popover>
  );
}

function SourceTabs({ sources, active, onChange }: { sources: ModelSource[]; active: ModelSource; onChange: (source: ModelSource) => void }) {
  const { t } = useTranslation();
  return (
    <div role="tablist" aria-label={t("modelsSettings.picker.source")} className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
      {sources.map((source) => (
        <button
          key={source}
          type="button"
          role="tab"
          aria-selected={active === source}
          onClick={() => onChange(source)}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus",
            active === source ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t(`modelsSettings.sources.${source}`)}
        </button>
      ))}
    </div>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
      <Search size={14} className="shrink-0 text-muted-foreground" />
      <input
        dir="auto"
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("bbAgent.searchModels")}
        aria-label={t("bbAgent.searchModels")}
        className="input-inline min-w-0 flex-1 bg-transparent p-0 text-sm outline-none placeholder:text-muted"
      />
    </label>
  );
}

function OptionRow({ selected, disabled, onSelect, title, subtitle, trailing }: {
  selected: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-2 rounded-md px-2 py-1.5", selected ? "bg-primary/10" : "hover:bg-default/60", disabled && "opacity-60")}>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        aria-disabled={disabled || !onSelect}
        disabled={disabled || !onSelect}
        onClick={onSelect}
        className="min-w-0 flex-1 text-start outline-none focus-visible:underline disabled:cursor-default"
      >
        <span className="block truncate text-sm text-foreground">{title}</span>
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </button>
      {trailing}
      {selected && <Check size={14} className="shrink-0 text-primary" />}
    </div>
  );
}

function GroupHeader({ icon, name, action }: { icon: ReactNode; name: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2 pt-3 pb-1">
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground">{name}</span>
      {action}
    </div>
  );
}

function CloudGroup({ task, group, selection, query, onOpenForm }: {
  task: ModelTask;
  group: CatalogGroup;
  selection: TaskSelection;
  query: string;
  onOpenForm: (form: "openrouter" | "custom") => void;
}) {
  const { t } = useTranslation();
  const credentials = useCredentialValues();
  const [editingKey, setEditingKey] = useState(false);
  const entry = findProvider(group.providerId);
  const ready = !entry || isProviderReady(entry, capabilityOf(task), credentials);
  const isCurrent = selection.source === "cloud" && selection.providerId === group.providerId;

  if (group.form) {
    if (!matchesQuery(query, group.name)) return null;
    const form = group.form;
    return (
      <>
        <GroupHeader icon={<ProviderIcon provider={group.providerId} className="size-4" />} name={group.name} />
        <OptionRow
          selected={isCurrent}
          onSelect={() => onOpenForm(form)}
          title={isCurrent && selection.modelId ? selection.modelId : t(`modelsSettings.picker.${form}Action`)}
          subtitle={isCurrent ? selection.endpoint || group.name : t(`modelsSettings.picker.${form}Hint`)}
          trailing={<ChevronRight size={14} className="shrink-0 text-muted-foreground rtl:rotate-180" />}
        />
      </>
    );
  }

  const models = group.models.filter((model) => matchesQuery(query, model.name, model.id, group.name));
  if (!models.length) return null;
  return (
    <>
      <GroupHeader
        icon={<ProviderIcon provider={group.providerId} className="size-4" />}
        name={group.name}
        action={entry && (!ready || editingKey) ? (
          <button type="button" onClick={() => setEditingKey((value) => !value)} className="rounded px-1.5 text-xs text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus">
            {editingKey ? t("common.close") : t("modelsSettings.providers.addKey")}
          </button>
        ) : undefined}
      />
      {entry && editingKey && (
        <div className="mx-2 mb-2 rounded-md border border-border p-2.5">
          <ProviderCredentialsForm entry={entry} capability={capabilityOf(task)} />
        </div>
      )}
      {models.map((model) => (
        <OptionRow
          key={model.id}
          selected={isCurrent && selection.modelId === model.id}
          onSelect={() => selectCloudModel(task, group.providerId, model.id)}
          title={model.name}
          subtitle={model.description}
        />
      ))}
    </>
  );
}

function SpeechCustomForm({ selection }: { selection: TaskSelection }) {
  const { t } = useTranslation();
  const { baseUrl, apiKey, setApiKey, setBaseUrl } = useSettingsStore(useShallow((state) => ({
    baseUrl: state.uploadCloudTranscriptionBaseUrl,
    apiKey: state.customTranscriptionApiKey,
    setApiKey: state.setCustomTranscriptionApiKey,
    setBaseUrl: state.setUploadCloudTranscriptionBaseUrl,
  })));
  const isCurrent = selection.source === "cloud" && selection.providerId === "custom";
  const [model, setModel] = useState(isCurrent ? selection.modelId : "");

  // A URL that belongs to a listed provider selects that provider instead.
  const normalizeOnBlur = () => {
    const normalized = normalizeBaseUrl((baseUrl || "").trim());
    if (!normalized) return;
    if (normalized !== baseUrl) setBaseUrl(normalized);
    const known = getTranscriptionProviders().find((provider) => normalizeBaseUrl(provider.baseUrl) === normalized);
    if (known) selectCloudModel("upload", known.id, known.models[0]?.id ?? "");
  };

  return (
    <div className="space-y-3">
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-foreground">{t("transcription.endpointUrl")}</span>
        <Input dir="ltr" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} onBlur={normalizeOnBlur} placeholder="https://your-api.example.com/v1" className="h-8 text-sm" />
      </label>
      <ApiKeyInput apiKey={apiKey} setApiKey={setApiKey} label={t("transcription.apiKeyOptional")} helpText="" />
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-foreground">{t("common.model")}</span>
        <Input dir="ltr" value={model} onChange={(event) => setModel(event.target.value)} placeholder="whisper-1" className="h-8 text-sm" />
      </label>
      {/azure\.com/i.test(baseUrl || "") && <p className="text-xs text-muted-foreground">{t("transcription.azureHint")}</p>}
      <UseButton active={isCurrent && selection.modelId === model.trim()} disabled={!baseUrl.trim() || !model.trim()} onUse={() => selectCloudModel("upload", "custom", model.trim())} />
    </div>
  );
}

function UseButton({ active, disabled, onUse }: { active: boolean; disabled?: boolean; onUse: () => void }) {
  const { t } = useTranslation();
  return active ? (
    <p className="flex items-center gap-1.5 text-xs text-success"><Check size={13} />{t("modelsSettings.picker.inUse")}</p>
  ) : (
    <button type="button" disabled={disabled} onClick={onUse} className="button button--primary button--sm w-full disabled:opacity-50">
      {t("modelsSettings.picker.useThis")}
    </button>
  );
}

function LanguageEndpointForm({ task, form, selection }: { task: LanguageTask; form: "openrouter" | "custom"; selection: TaskSelection }) {
  const config = useSettingsStore(useShallow((state) => selectResolvedLLMConfig(state, task)));
  const openrouterApiKey = useSettingsStore((state) => state.openrouterApiKey);
  const setOpenrouterApiKey = useSettingsStore((state) => state.setOpenrouterApiKey);
  const isCurrent = selection.source === "cloud" && selection.providerId === form;
  if (form === "openrouter") {
    return (
      <OpenAICompatiblePanel
        key="openrouter"
        baseUrl={API_ENDPOINTS.OPENROUTER_BASE}
        setBaseUrl={() => {}}
        apiKey={openrouterApiKey}
        setApiKey={setOpenrouterApiKey}
        model={isCurrent ? selection.modelId : ""}
        setModel={(model) => selectCloudModel(task, "openrouter", model)}
        lockedBaseUrl
        apiKeyRequired
        getKeyUrl="https://openrouter.ai/keys"
      />
    );
  }
  return (
    <OpenAICompatiblePanel
      key="custom"
      baseUrl={config.cloudBaseUrl ?? ""}
      setBaseUrl={(value) => setResolvedLLMConfig(task, { cloudBaseUrl: value })}
      apiKey={config.customApiKey ?? ""}
      setApiKey={(value) => setResolvedLLMConfig(task, { customApiKey: value }) ?? { success: false }}
      model={isCurrent ? selection.modelId : ""}
      setModel={(model) => selectCloudModel(task, "custom", model)}
      defaultBaseUrl={API_ENDPOINTS.OPENAI_BASE}
    />
  );
}

function FormView({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus">
        <ArrowLeft size={13} className="rtl:rotate-180" />
        {t("common.back")}
      </button>
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      {children}
    </div>
  );
}

function CloudTab({ task, selection }: { task: ModelTask; selection: TaskSelection }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<"openrouter" | "custom" | null>(null);
  const { models: tinfoilModels } = useTinfoilModels(!isSpeechTask(task));
  const groups = useMemo(() => cloudGroups(task, t, tinfoilModels), [task, t, tinfoilModels]);

  if (form) {
    const group = groups.find((item) => item.form === form);
    return (
      <FormView title={group?.name ?? ""} onBack={() => setForm(null)}>
        {isSpeechTask(task) ? <SpeechCustomForm selection={selection} /> : <LanguageEndpointForm task={task} form={form} selection={selection} />}
      </FormView>
    );
  }
  return (
    <div className="space-y-1">
      <SearchField value={query} onChange={setQuery} />
      <div role="listbox" aria-label={t("common.model")} className="max-h-[min(18rem,calc(100vh-22rem))] overflow-y-auto">
        {groups.map((group) => (
          <CloudGroup key={group.providerId} task={task} group={group} selection={selection} query={query} onOpenForm={setForm} />
        ))}
      </div>
    </div>
  );
}

function LocalRow({ task, entry, selected }: { task: ModelTask; entry: LocalModelEntry; selected: boolean }) {
  const { t } = useTranslation();
  const inventory = useLocalModelInventory();
  const state = inventory.downloadState(entry);
  const trailing = entry.downloaded || entry.unavailableReason ? undefined : state ? (
    <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
      {state.installing ? t("modelsSettings.local.installing") : `${Math.round(state.progress)}%`}
      {!state.installing && (
        <button type="button" disabled={state.cancelling} onClick={() => inventory.cancel(entry)} aria-label={t("common.cancel")} className="rounded p-0.5 outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-focus">
          <X size={12} />
        </button>
      )}
    </span>
  ) : (
    <button
      type="button"
      onClick={() => inventory.download(entry)}
      className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-foreground outline-none hover:bg-default focus-visible:ring-2 focus-visible:ring-focus"
    >
      <Download size={12} />
      {t("common.download")}
    </button>
  );
  return (
    <OptionRow
      selected={selected}
      disabled={!!entry.unavailableReason}
      onSelect={entry.downloaded && !entry.unavailableReason ? () => selectLocalModel(task, entry) : undefined}
      title={<>{entry.name}{entry.recommended && <span className="ms-1.5 text-2xs font-medium text-primary">{t("common.recommended")}</span>}</>}
      subtitle={entry.unavailableReason ?? (entry.downloaded ? `${entry.size} · ${t("modelsSettings.local.downloaded")}` : entry.size)}
      trailing={trailing}
    />
  );
}

function LocalTab({ task, selection }: { task: ModelTask; selection: TaskSelection }) {
  const { t } = useTranslation();
  const inventory = useLocalModelInventory();
  const [query, setQuery] = useState("");
  const kind = isSpeechTask(task) ? "speech" : "language";
  const groups = localGroups(kind, inventory[kind]);
  return (
    <div className="space-y-1">
      <SearchField value={query} onChange={setQuery} />
      <div role="listbox" aria-label={t("common.model")} className="max-h-[min(18rem,calc(100vh-22rem))] overflow-y-auto">
        {groups.map((group) => {
          const entries = group.entries.filter((entry) => matchesQuery(query, entry.name, entry.id, group.name));
          if (!entries.length) return null;
          return (
            <div key={group.id}>
              <GroupHeader icon={<ProviderIcon provider={group.id} className="size-4" />} name={group.name} />
              {entries.map((entry) => (
                <LocalRow key={entry.id} task={task} entry={entry} selected={selection.source === "local" && selection.modelId === entry.id} />
              ))}
            </div>
          );
        })}
      </div>
      <p className="px-2 pt-1 text-xs text-muted-foreground">{t("modelsSettings.picker.localHint")}</p>
    </div>
  );
}

function LanguageSelfHosted({ task, selection }: { task: LanguageTask; selection: TaskSelection }) {
  const { t } = useTranslation();
  const config = useSettingsStore(useShallow((state) => selectResolvedLLMConfig(state, task)));
  return (
    <OpenAICompatiblePanel
      baseUrl={config.remoteUrl ?? ""}
      setBaseUrl={(value) => setResolvedLLMConfig(task, { remoteUrl: value })}
      apiKey={config.customApiKey ?? ""}
      setApiKey={(value) => setResolvedLLMConfig(task, { customApiKey: value }) ?? { success: false }}
      model={selection.source === "self-hosted" ? selection.modelId : ""}
      setModel={(model) => selectSelfHosted(task, model)}
      baseUrlPlaceholder="http://127.0.0.1:11434/v1"
      helpExamples={<p className="text-xs text-muted-foreground">{t("reasoning.selfHosted.endpointHelp")}</p>}
    />
  );
}

function BbTab({ task, selection }: { task: LanguageTask; selection: TaskSelection }) {
  const { t } = useTranslation();
  const { enabled, error } = useBbCatalog();
  const preferences = useSettingsStore((state) => state.bbAgentPreferences);
  const isBb = selection.source === "bb";
  const defaultHarness = enabled.find((item) => item.id === preferences?.defaultProvider);
  const followsDefault = isBb && !!selection.followsDefault;
  return (
    <div className="space-y-2">
      <OptionRow
        selected={followsDefault}
        onSelect={() => selectBb(task, null)}
        title={t("modelsSettings.picker.bbDefault")}
        subtitle={defaultHarness
          ? <BbSelectionLabel harness={defaultHarness} model={preferences?.defaults[defaultHarness.id]?.model ?? ""} reasoningLevel={preferences?.defaults[defaultHarness.id]?.reasoningLevel ?? ""} />
          : t("bbAgent.noHarness")}
      />
      <div className="border-t border-border pt-2">
        <BbModelPanel
          harnesses={enabled}
          selection={isBb && !followsDefault && selection.providerId ? { provider: selection.providerId, model: selection.modelId, reasoningLevel: selection.reasoningLevel ?? "" } : null}
          onSelect={(next) => selectBb(task, next)}
          className="w-full"
        />
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function ThinkingToggle({ task }: { task: LanguageTask }) {
  const { t } = useTranslation();
  const config = useSettingsStore(useShallow((state) => selectResolvedLLMConfig(state, task)));
  const applies = config.mode === "self-hosted"
    || (config.mode === "providers" && (config.provider === "custom" || config.provider === "openrouter" || !!getCloudModel(config.model)?.supportsThinking))
    || (config.mode === "local" && !!getLocalModel(config.model)?.supportsThinking);
  if (!applies) return null;
  return (
    <div className="flex items-start justify-between gap-3 border-t border-border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{t("reasoning.disableThinking.label")}</p>
        <p className="text-xs text-muted-foreground">{t("reasoning.disableThinking.help")}</p>
      </div>
      <Toggle checked={config.disableThinking} onChange={(value) => setResolvedLLMConfig(task, { disableThinking: value })} ariaLabel={t("reasoning.disableThinking.label")} />
    </div>
  );
}

function TaskModelPanel({ task, selection }: { task: ModelTask; selection: TaskSelection }) {
  const sources = taskSources(task);
  const [source, setSource] = useState<ModelSource>(sources.includes(selection.source) ? selection.source : "cloud");
  return (
    <div className="flex max-h-[calc(100vh-4rem)] w-[26rem] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto">
      <div className="space-y-3 p-3">
        <SourceTabs sources={sources} active={source} onChange={setSource} />
        {source === "cloud" && <CloudTab task={task} selection={selection} />}
        {source === "local" && <LocalTab task={task} selection={selection} />}
        {source === "self-hosted" && !isSpeechTask(task) && <LanguageSelfHosted task={task as LanguageTask} selection={selection} />}
        {source === "bb" && !isSpeechTask(task) && <BbTab task={task} selection={selection} />}
      </div>
      {!isSpeechTask(task) && source !== "bb" && <ThinkingToggle task={task} />}
    </div>
  );
}
