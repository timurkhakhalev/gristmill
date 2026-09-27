import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { SettingsPanel } from "../../ui/SettingsSection";
import { Download, ExternalLink, Trash2, X } from "../../icons";
import { cn } from "../../lib/utils";
import { createExternalLinkHandler } from "../../../utils/externalLinks";
import { useLocalModelInventory, type LocalModelEntry } from "./inventoryContext";
import { localGroups } from "./taskCatalog";
import { useTaskSelection } from "./taskModels";

function useModelsInUse(): Set<string> {
  const meeting = useTaskSelection("meeting");
  const upload = useTaskSelection("upload");
  const summary = useTaskSelection("noteFormatting");
  const chat = useTaskSelection("chatIntelligence");
  return new Set([meeting, upload, summary, chat].filter((item) => item.source === "local").map((item) => item.modelId));
}

function LocalModelRow({ entry, inUse }: { entry: LocalModelEntry; inUse: boolean }) {
  const { t } = useTranslation();
  const inventory = useLocalModelInventory();
  const state = inventory.downloadState(entry);
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm text-foreground">{entry.name}</span>
          {entry.recommended && <span className="rounded bg-primary/10 px-1.5 text-2xs font-medium text-primary">{t("common.recommended")}</span>}
          {inUse && <span className="rounded bg-success/10 px-1.5 text-2xs font-medium text-success">{t("modelsSettings.local.inUse")}</span>}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{entry.size}</span>
          {entry.unavailableReason && <span className="text-warning">{entry.unavailableReason}</span>}
          {entry.modelCardUrl && (
            <a href={entry.modelCardUrl} onClick={createExternalLinkHandler(entry.modelCardUrl)} className="inline-flex items-center gap-0.5 hover:text-foreground">
              {t("transcription.modelCard")}
              <ExternalLink size={11} />
            </a>
          )}
        </div>
        {state && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress)} aria-label={entry.name}>
            <div className={cn("h-full bg-primary transition-[width]", state.installing && "animate-pulse")} style={{ width: `${state.installing ? 100 : state.progress}%` }} />
          </div>
        )}
      </div>
      {state ? (
        <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
          {state.installing ? t("modelsSettings.local.installing") : `${Math.round(state.progress)}%`}
          {!state.installing && (
            <button type="button" disabled={state.cancelling} onClick={() => inventory.cancel(entry)} aria-label={t("common.cancel")} className="rounded p-1 outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-focus">
              <X size={13} />
            </button>
          )}
        </span>
      ) : entry.downloaded ? (
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("modelsSettings.local.downloaded")}</span>
          <button type="button" onClick={() => inventory.remove(entry)} aria-label={t("modelsSettings.local.remove", { model: entry.name })} className="rounded p-1 text-muted-foreground outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-focus">
            <Trash2 size={14} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={!!entry.unavailableReason}
          onClick={() => inventory.download(entry)}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground outline-none hover:bg-default focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
        >
          <Download size={12} />
          {t("common.download")}
        </button>
      )}
    </div>
  );
}

/** Every on-device model in one place: download, cancel and remove. Choosing one happens per task. */
export function LocalModelsSettings() {
  const { t } = useTranslation();
  const inventory = useLocalModelInventory();
  const inUse = useModelsInUse();
  const [kind, setKind] = useState<"speech" | "language">("speech");
  const groups = localGroups(kind, inventory[kind]);
  return (
    <div className="space-y-2">
      <div role="tablist" aria-label={t("modelsSettings.local.title")} className="inline-flex gap-1 rounded-lg bg-surface-2 p-0.5">
        {(["speech", "language"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={kind === item}
            onClick={() => setKind(item)}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus",
              kind === item ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t(`modelsSettings.local.${item}`)}
          </button>
        ))}
      </div>
      <SettingsPanel>
        {groups.map((group) => (
          <div key={group.id}>
            <div className="flex items-center gap-2 bg-surface-2/40 px-4 py-1.5">
              <ProviderIcon provider={group.id} className="size-3.5" />
              <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{group.name}</span>
            </div>
            <div className="divide-y divide-border">
              {group.entries.map((entry) => <LocalModelRow key={entry.id} entry={entry} inUse={inUse.has(entry.id)} />)}
            </div>
          </div>
        ))}
      </SettingsPanel>
    </div>
  );
}
