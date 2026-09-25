import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Textarea } from "./textarea";
import { Eye, Edit3, Play, Save, RotateCcw, Copy, TestTube, AlertTriangle, Check } from "../icons";
import { AlertDialog } from "./dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useAgentName } from "../../utils/agentName";
import ReasoningService from "../../services/ReasoningService";
import { getModelProvider } from "../../models/ModelRegistry";
import logger from "../../utils/logger";
import { getDefaultPromptText, resolvePrompt } from "../../config/prompts";
import { useSettingsStore } from "../../stores/settingsStore";

type NotesPromptKind = "cleanup" | "chatAgent";

interface PromptStudioProps {
  className?: string;
  kind?: NotesPromptKind;
}

const providerLabel = (provider: string) =>
  ({
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Gemini",
    groq: "Groq",
    openrouter: "OpenRouter",
    custom: "Custom endpoint",
    local: "Local",
  })[provider] ?? provider;

/** Edit and exercise the prompts used by Notes AI Actions. */
export default function PromptStudio({ className = "", kind = "cleanup" }: PromptStudioProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"current" | "edit" | "test">("current");
  const [testText, setTestText] = useState(() => t("promptStudio.defaultTestInput"));
  const [testResult, setTestResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const { agentName } = useAgentName();
  const settings = useSettingsStore();
  const customPrompt = settings.customPrompts[kind] ?? "";
  const defaultPrompt = getDefaultPromptText(kind, settings.uiLanguage);
  const [editedPrompt, setEditedPrompt] = useState(customPrompt || defaultPrompt);
  const currentPrompt = customPrompt || defaultPrompt;
  const isCustomPrompt = customPrompt.length > 0;
  const model = kind === "chatAgent" ? settings.chatAgentModel : settings.cleanupModel;
  const provider = kind === "chatAgent" ? settings.chatAgentProvider : settings.cleanupProvider;
  const useModel = kind === "chatAgent" ? true : settings.useCleanupModel;

  const savePrompt = () => {
    settings.setCustomPrompt(kind, editedPrompt === defaultPrompt ? "" : editedPrompt);
    showAlertDialog({ title: t("promptStudio.dialogs.saved.title"), description: t("promptStudio.dialogs.saved.description") });
  };

  const resetToDefault = () => {
    setEditedPrompt(defaultPrompt);
    settings.setCustomPrompt(kind, "");
    showAlertDialog({ title: t("promptStudio.dialogs.reset.title"), description: t("promptStudio.dialogs.reset.description") });
  };

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const testPrompt = async () => {
    if (!testText.trim() || !useModel) return;
    setIsLoading(true);
    setTestResult("");
    const previous = customPrompt;
    settings.setCustomPrompt(kind, editedPrompt);
    try {
      if (!model) {
        setTestResult(t("promptStudio.test.noModelSelected"));
        return;
      }
      const result = await ReasoningService.processText(testText, model, agentName, {
        ...(kind === "chatAgent" ? { inferenceScope: "chatIntelligence" as const } : {}),
        disableThinking: settings.cleanupDisableThinking,
        systemPrompt: resolvePrompt(kind, { agentName, uiLanguage: settings.uiLanguage }),
      });
      setTestResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("PromptStudio test failed", { error: errorMessage }, "prompt-studio");
      setTestResult(t("promptStudio.test.failed", { error: errorMessage }));
    } finally {
      settings.setCustomPrompt(kind, previous);
      setIsLoading(false);
    }
  };

  const tabs = [
    { id: "current" as const, label: t("promptStudio.tabs.view"), icon: Eye },
    { id: "edit" as const, label: t("promptStudio.tabs.customize"), icon: Edit3 },
    { id: "test" as const, label: t("promptStudio.tabs.test"), icon: TestTube },
  ];

  return (
    <div className={className}>
      <AlertDialog open={alertDialog.open} onOpenChange={(open) => !open && hideAlertDialog()} title={alertDialog.title} description={alertDialog.description} onOk={() => {}} />
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card dark:border-border-subtle dark:bg-surface-2">
        <div className="flex border-b border-border/70 dark:border-border-subtle">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" onClick={() => setActiveTab(id)} className={`flex-1 border-b-2 px-4 py-3 text-xs font-medium ${activeTab === id ? "border-primary bg-primary/5 text-foreground" : "border-transparent text-muted-foreground"}`}>
              <Icon className="me-2 inline size-3.5" />{label}
            </button>
          ))}
        </div>
        {activeTab === "current" && (
          <div className="px-5 py-4">
            <div className="mb-3 flex items-center justify-between"><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">{isCustomPrompt ? t("promptStudio.view.customPrompt") : t("promptStudio.view.defaultPrompt")}</p><Button onClick={() => copyText(currentPrompt)} variant="ghost" size="sm" className="h-7 px-2 text-xs">{copiedPrompt ? <><Check className="me-1 inline size-3 text-success" />{t("promptStudio.common.copied")}</> : <><Copy className="me-1 inline size-3" />{t("promptStudio.common.copy")}</>}</Button></div>
            <pre dir="auto" className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-subtle/30 p-4 text-xs leading-relaxed text-muted-foreground">{currentPrompt.replace(/\{\{agentName\}\}/g, agentName)}</pre>
          </div>
        )}
        {activeTab === "edit" && (
          <div className="px-5 py-4">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{t("promptStudio.edit.cautionTextPrefix")}</p>
            <Textarea dir="auto" value={editedPrompt} onChange={(event) => setEditedPrompt(event.target.value)} rows={16} className="font-mono text-xs leading-relaxed" placeholder={t("promptStudio.edit.placeholder")} />
            <div className="mt-4 flex gap-2"><Button onClick={savePrompt} size="sm" className="flex-1"><Save className="me-2 size-3.5" />{t("promptStudio.common.save")}</Button><Button onClick={resetToDefault} variant="outline" size="sm"><RotateCcw className="me-2 size-3.5" />{t("promptStudio.common.reset")}</Button></div>
          </div>
        )}
        {activeTab === "test" && (
          <div className="divide-y divide-border/60 dark:divide-border-subtle">
            {!useModel && <div className="px-5 py-4"><div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 px-4 py-3 text-xs text-muted-foreground"><AlertTriangle className="mt-0.5 size-3.5 text-warning" />{t("promptStudio.test.disabledReasoning")}</div></div>}
            <div className="flex items-center gap-4 px-5 py-4 text-xs"><span className="text-muted-foreground">{t("promptStudio.test.modelLabel")}: <b className="font-mono text-foreground">{model || t("promptStudio.test.none")}</b></span><span className="text-muted-foreground">{t("promptStudio.test.providerLabel")}: <b className="text-foreground">{providerLabel(provider)}</b></span></div>
            <div className="px-5 py-4"><p className="mb-2 text-xs font-medium text-foreground">{t("promptStudio.test.inputLabel")}</p><Textarea dir="auto" value={testText} onChange={(event) => setTestText(event.target.value)} rows={3} className="text-xs" /></div>
            <div className="px-5 py-4"><Button onClick={testPrompt} disabled={!testText.trim() || isLoading || !useModel} size="sm" className="w-full"><Play className="me-2 size-3.5" />{isLoading ? t("promptStudio.test.processing") : t("promptStudio.test.run")}</Button></div>
            {testResult && <div className="px-5 py-4"><div className="mb-2 flex items-center justify-between"><p className="text-xs font-medium">{t("promptStudio.test.outputLabel")}</p><Button onClick={() => copyText(testResult)} variant="ghost" size="sm" className="h-6 px-1.5"><Copy className="size-3" /></Button></div><pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-subtle/30 p-4 text-xs">{testResult}</pre></div>}
          </div>
        )}
      </div>
    </div>
  );
}
