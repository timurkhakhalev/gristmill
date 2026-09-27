import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../../stores/settingsStore";
import { SettingsCard, SettingsCardRow } from "../../ui/SettingsSection";
import { Toggle } from "../../ui/toggle";
import BbAgentSettings from "../BbAgentSettings";
import { LocalModelInventoryProvider } from "./LocalModelInventory";
import { useLocalModelInventory } from "./inventoryContext";
import { LocalModelsSettings } from "./LocalModelsSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { TaskModelControl } from "./TaskModelPicker";
import { type ModelTask } from "./taskModels";
import { useTranscriptionPolicies } from "./transcriptionPolicies";

const TASK_ROWS: Array<{ task: ModelTask; anchor: string; labelKey: string; descriptionKey: string }> = [
  { task: "meeting", anchor: "meeting", labelKey: "modelsSettings.tasks.meeting", descriptionKey: "modelsSettings.tasks.meetingDescription" },
  { task: "upload", anchor: "upload", labelKey: "modelsSettings.tasks.upload", descriptionKey: "modelsSettings.tasks.uploadDescription" },
  { task: "noteFormatting", anchor: "summary", labelKey: "modelsSettings.tasks.summary", descriptionKey: "modelsSettings.tasks.summaryDescription" },
  { task: "chatIntelligence", anchor: "chat", labelKey: "modelsSettings.tasks.chat", descriptionKey: "modelsSettings.tasks.chatDescription" },
];

function ModelsContent({ focus }: { focus?: string }) {
  const { t } = useTranslation();
  useTranscriptionPolicies(useLocalModelInventory().sherpaSupported);
  const rootRef = useRef<HTMLDivElement>(null);
  const speakerDetection = useSettingsStore((state) => state.speakerDiarizationEnabled);
  const setSpeakerDetection = useSettingsStore((state) => state.setSpeakerDiarizationEnabled);
  const chatPrompt = useSettingsStore((state) => state.customPrompts.chatAgent);
  const setCustomPrompt = useSettingsStore((state) => state.setCustomPrompt);

  // Deep links (e.g. from a failed summary) land on the matching task row.
  useEffect(() => {
    if (!focus) return;
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-task-anchor="${focus}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector<HTMLElement>("button")?.focus();
  }, [focus]);

  return (
    <div ref={rootRef} className="space-y-8">
      <SettingsCard title={t("modelsSettings.tasks.title")}>
        {TASK_ROWS.map((row) => (
          <div key={row.task} data-task-anchor={row.anchor}>
            <SettingsCardRow label={t(row.labelKey)} description={t(row.descriptionKey)}>
              <TaskModelControl task={row.task} label={t(row.labelKey)} />
            </SettingsCardRow>
          </div>
        ))}
        <SettingsCardRow label={t("settings.meeting.speakerDetection.title")} description={t("settings.meeting.speakerDetection.description")}>
          <Toggle checked={speakerDetection} onChange={setSpeakerDetection} />
        </SettingsCardRow>
      </SettingsCard>

      <SettingsCard title={t("modelsSettings.chatPrompt")}>
        <div className="space-y-2 px-4 py-3">
          <p className="text-xs text-muted-foreground">{t("agentMode.settings.systemPromptDescription")}</p>
          <textarea
            dir="auto"
            value={chatPrompt}
            onChange={(event) => setCustomPrompt("chatAgent", event.target.value)}
            placeholder={t("agentMode.settings.systemPromptPlaceholder")}
            aria-label={t("agentMode.settings.systemPrompt")}
            rows={3}
            className="w-full resize-y rounded-md border border-border/70 bg-transparent px-3 py-2 text-xs placeholder:text-muted focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-focus"
          />
        </div>
      </SettingsCard>

      <section className="space-y-2">
        <div className="px-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("modelsSettings.providers.title")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("modelsSettings.providers.description")}</p>
        </div>
        <ProvidersSettings />
      </section>

      <section className="space-y-2">
        <div className="px-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("modelsSettings.bb.title")}</h3>
        </div>
        <BbAgentSettings />
      </section>

      <section className="space-y-2">
        <div className="px-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("modelsSettings.local.title")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("modelsSettings.local.description")}</p>
        </div>
        <LocalModelsSettings />
      </section>
    </div>
  );
}

/** Settings → Models: which model each task uses, the providers behind them and on-device models. */
export default function ModelsSettings({ focus }: { focus?: string }) {
  return (
    <LocalModelInventoryProvider>
      <ModelsContent focus={focus} />
    </LocalModelInventoryProvider>
  );
}
