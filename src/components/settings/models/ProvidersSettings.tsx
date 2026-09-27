import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { SettingsPanel } from "../../ui/SettingsSection";
import { ChevronDown } from "../../icons";
import { cn } from "../../lib/utils";
import { isProviderReady, PROVIDER_DIRECTORY, type ProviderEntry } from "./providerDirectory";
import { ProviderCredentialsForm } from "./ProviderCredentialsForm";
import { useCredentialValues } from "./useCredentialValues";

function StatusBadge({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", connected ? "text-foreground" : "text-muted-foreground")}>
      <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-muted-foreground/40")} aria-hidden />
      {connected ? t("modelsSettings.providers.connected") : t("modelsSettings.providers.notConnected")}
    </span>
  );
}

function ProviderRow({ entry, open, onToggle }: { entry: ProviderEntry; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const values = useCredentialValues();
  const connected = entry.capabilities.some((capability) => isProviderReady(entry, capability, values));
  const panelId = `provider-${entry.id}`;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-start outline-none transition-colors hover:bg-default/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
      >
        <span aria-hidden className="flex shrink-0"><ProviderIcon provider={entry.id} className="size-5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{entry.name}</span>
          <span className="block text-xs text-muted-foreground">
            {entry.capabilities.map((capability) => t(`modelsSettings.providers.capability.${capability}`)).join(" · ")}
          </span>
        </span>
        <StatusBadge connected={connected} />
        <ChevronDown size={14} className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div id={panelId} className="border-t border-border bg-surface-2/40 px-4 py-3">
          <ProviderCredentialsForm entry={entry} />
        </div>
      )}
    </div>
  );
}

/** App-wide API keys: each provider is configured once and every task can use it. */
export function ProvidersSettings() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <SettingsPanel>
      {PROVIDER_DIRECTORY.map((entry) => (
        <ProviderRow key={entry.id} entry={entry} open={open === entry.id} onToggle={() => setOpen((current) => (current === entry.id ? null : entry.id))} />
      ))}
    </SettingsPanel>
  );
}
