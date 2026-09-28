import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { moveBbHarness } from "../../config/bbAgentPreferences";
import { Toggle } from "../ui/toggle";
import { cn } from "../lib/utils";
import { HarnessIcon } from "../bb/HarnessIcon";
import { useBbCatalog } from "../bb/useBbCatalog";

function GripIcon() {
  return (
    <svg viewBox="0 0 10 16" className="h-4 w-2.5" fill="currentColor" aria-hidden>
      {[3, 8, 13].flatMap((y) => [2, 8].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" />))}
    </svg>
  );
}

/** App-wide bb harnesses: order, enablement and default harness. */
export default function BbAgentSettings() {
  const { t } = useTranslation();
  const { harnesses, error, loading } = useBbCatalog();
  const preferences = useSettingsStore((state) => state.bbAgentPreferences);
  const setPreferences = useSettingsStore((state) => state.setBbAgentPreferences);
  const [dragging, setDragging] = useState<string | null>(null);

  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (loading || !preferences) return <p className="text-sm text-muted">{t("bbAgent.loadingHarnesses")}</p>;
  if (!harnesses.length) return <p className="text-sm text-muted">{t("bbAgent.noHarness")}</p>;

  const ids = harnesses.map((item) => item.id);
  // Unavailable harnesses keep their saved slot at the end instead of being forgotten.
  const move = (id: string, toIndex: number) => setPreferences({
    ...preferences,
    order: [...moveBbHarness(ids, id, toIndex), ...preferences.order.filter((item) => !ids.includes(item))],
  });
  const setEnabled = (id: string, enabled: boolean) => setPreferences({
    ...preferences,
    disabled: enabled ? preferences.disabled.filter((item) => item !== id) : [...preferences.disabled, id],
  });

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{t("bbAgent.settingsDescription")}</p>
      <ul className="divide-y divide-border rounded-lg border border-border" aria-label={t("bbAgent.harnesses")}>
        {harnesses.map((harness, index) => {
          const enabled = !preferences.disabled.includes(harness.id);
          const isDefault = preferences.defaultProvider === harness.id;
          return (
            <li
              key={harness.id}
              draggable
              onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragging(harness.id); }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (!dragging || dragging === harness.id) return;
                event.preventDefault();
                move(dragging, index);
              }}
              className={cn("flex items-center gap-3 px-3 py-2", dragging === harness.id && "opacity-50", !enabled && "text-muted")}
            >
              <button
                type="button"
                aria-label={t("bbAgent.reorder", { harness: harness.displayName })}
                title={t("bbAgent.reorderHint")}
                className="cursor-grab rounded text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus active:cursor-grabbing"
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  move(harness.id, index + (event.key === "ArrowUp" ? -1 : 1));
                }}
              >
                <GripIcon />
              </button>
              <HarnessIcon logo={harness.logo} className="size-5" />
              <span className="min-w-0 flex-1 truncate text-sm">{harness.displayName}</span>
              {isDefault ? (
                <span className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted">{t("bbAgent.default")}</span>
              ) : (
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => setPreferences({ ...preferences, defaultProvider: harness.id })}
                  className="rounded px-1.5 py-0.5 text-xs text-foreground outline-none hover:bg-default focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40"
                >
                  {t("bbAgent.makeDefault")}
                </button>
              )}
              <Toggle
                checked={enabled}
                disabled={isDefault}
                onChange={(value) => setEnabled(harness.id, value)}
                ariaLabel={t("bbAgent.enableHarness", { harness: harness.displayName })}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
