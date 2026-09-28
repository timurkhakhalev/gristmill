import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Search } from "../icons";
import { cn } from "../lib/utils";
import { HarnessIcon } from "./HarnessIcon";
import { defaultReasoningFor, useBbModels } from "./useBbCatalog";
import type { BbHarness, BbSelection } from "../../contracts/bb";

const ROW_HEIGHT = 32;

export interface BbPanelTab {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onSelect: () => void;
}

interface BbModelPanelProps {
  /** Harness tabs in display order. */
  harnesses: BbHarness[];
  /** The committed selection, marked in the list and used for the reasoning row. */
  selection: BbSelection | null;
  onSelect: (selection: BbSelection) => void;
  /** Non-bb tabs rendered before the harnesses (e.g. the chat's API route). */
  leadingTabs?: BbPanelTab[];
  /** Hides the harness row when the panel edits a single harness. */
  hideTabs?: boolean;
  /** Content shown instead of the model list while a leading tab is open. */
  leadingContent?: ReactNode;
  className?: string;
}

/** bb-style picker: harness tabs, model search over a virtual list, reasoning level. */
export function BbModelPanel({ harnesses, selection, onSelect, leadingTabs = [], hideTabs = false, leadingContent, className = "w-80" }: BbModelPanelProps) {
  const { t } = useTranslation();
  // What the panel shows; a leading tab (the chat's API route) or a harness.
  const [tab, setTab] = useState(() => {
    const lead = leadingTabs.find((item) => item.active);
    return lead ? `lead:${lead.id}` : selection?.provider || harnesses[0]?.id || "";
  });
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const leadingActive = tab.startsWith("lead:");
  const viewing = harnesses.some((item) => item.id === tab) ? tab : harnesses[0]?.id || "";
  const { models, error, loading } = useBbModels(leadingActive ? "" : viewing);
  const harness = harnesses.find((item) => item.id === viewing);

  const normalized = query.trim().toLowerCase();
  const filtered = useMemo(
    () => normalized
      ? models.filter((model) => model.displayName.toLowerCase().includes(normalized) || model.id.toLowerCase().includes(normalized))
      : models,
    [models, normalized]
  );

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => filtered[index].id,
    overscan: 8,
  });

  // Opening (or switching harness) lands on the committed model; searching restarts from the top.
  const selectedIndex = selection?.provider === viewing ? filtered.findIndex((model) => model.id === selection.model) : -1;
  useEffect(() => {
    const index = normalized ? 0 : Math.max(selectedIndex, 0);
    setActiveIndex(index);
    if (index > 0) virtualizer.scrollToIndex(index, { align: "center" });
    else virtualizer.scrollToOffset(0);
  }, [normalized, viewing, selectedIndex, virtualizer]);

  useEffect(() => {
    if (!leadingActive) searchRef.current?.focus();
  }, [viewing, leadingActive]);

  const selectedModel = selection?.provider === viewing ? models.find((model) => model.id === selection.model) : undefined;
  const levels = (selectedModel?.supportedReasoningEfforts ?? []).map(({ reasoningEffort }) => ({
    id: reasoningEffort,
    label: harness?.reasoningLevels?.find((level) => level.id === reasoningEffort)?.label ?? reasoningEffort,
  }));

  const choose = (index: number) => {
    const model = filtered[index];
    if (!model) return;
    const efforts = model.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [];
    const keep = selection?.reasoningLevel && efforts.includes(selection.reasoningLevel);
    onSelect({ provider: viewing, model: model.id, reasoningLevel: keep ? selection.reasoningLevel : defaultReasoningFor(model) });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.max(0, Math.min(filtered.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)));
      setActiveIndex(next);
      virtualizer.scrollToIndex(next);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  const tabClass = (active: boolean) => cn(
    "flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors",
    "focus-visible:ring-2 focus-visible:ring-focus",
    active ? "bg-default text-foreground" : "text-muted hover:bg-default/60 hover:text-foreground"
  );

  return (
    <div className={cn("flex flex-col", className)}>
      {!hideTabs && (
        <div role="tablist" aria-label={t("bbAgent.harness")} className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
          {leadingTabs.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === `lead:${item.id}`} title={item.label} className={tabClass(tab === `lead:${item.id}`)} onClick={() => { setTab(`lead:${item.id}`); item.onSelect(); }}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
          {harnesses.map((item) => {
            const active = !leadingActive && item.id === viewing;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={item.displayName}
                title={item.displayName}
                className={tabClass(active)}
                onClick={() => { setTab(item.id); setQuery(""); }}
              >
                <HarnessIcon logo={item.logo} />
              </button>
            );
          })}
        </div>
      )}
      <div className="flex h-64 min-h-0 flex-col">
        {leadingActive ? leadingContent : (
          <>
          <label className="flex shrink-0 items-center gap-2 border-b border-border px-1 py-2">
            <Search size={14} className="shrink-0 text-muted" />
            <input
              dir="auto"
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("bbAgent.searchModels")}
              aria-label={t("bbAgent.searchModels")}
              className="input-inline min-w-0 flex-1 bg-transparent p-0 text-sm outline-none placeholder:text-muted"
            />
          </label>
          <div className="shrink-0 px-1 pt-2 pb-1 text-2xs font-medium uppercase tracking-wide text-muted">{t("bbAgent.model")}</div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <p role="alert" className="px-2 py-3 text-xs text-danger">{error}</p>
            ) : loading ? (
              <p className="px-2 py-3 text-xs text-muted">{t("bbAgent.loadingModels")}</p>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted">{models.length ? t("bbAgent.noMatches") : t("bbAgent.noModel")}</p>
            ) : (
              <div role="listbox" aria-label={t("bbAgent.model")} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const model = filtered[item.index];
                  const selected = selection?.provider === viewing && selection.model === model.id;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      title={model.displayName}
                      onMouseEnter={() => setActiveIndex(item.index)}
                      onClick={() => choose(item.index)}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 text-start text-sm outline-none",
                        item.index === activeIndex ? "bg-default text-foreground" : selected ? "bg-default/60 text-foreground" : "text-foreground/90"
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
                      {selected && <Check size={14} className="shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {levels.length > 0 && selection && (
            <div className="mt-1 shrink-0 border-t border-border pt-2">
              <div className="px-1 pb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">{t("bbAgent.reasoning")}</div>
              <div role="radiogroup" aria-label={t("bbAgent.reasoning")} className="flex flex-wrap gap-1">
                {levels.map((level) => (
                  <button
                    key={level.id}
                    type="button"
                    role="radio"
                    aria-checked={selection.reasoningLevel === level.id}
                    onClick={() => onSelect({ ...selection, reasoningLevel: level.id })}
                    className={cn(
                      "flex-1 rounded-md px-2 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus",
                      selection.reasoningLevel === level.id ? "bg-default text-foreground" : "text-muted hover:bg-default/60 hover:text-foreground"
                    )}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          </>
        )}
      </div>
    </div>
  );
}
