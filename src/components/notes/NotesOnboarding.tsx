import { useCallback, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { Check, Mic, Monitor, Sparkles } from "../icons";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import { selectResolvedMeetingTranscription } from "../../config/settingsSelectors";
import { getTranscriptionApiKey } from "../../services/fileTranscription";
import { useNotesOnboarding } from "../../hooks/useNotesOnboarding";
import { useSystemAudioPermission } from "../../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import { openSettings } from "../../utils/openSettings";

interface NotesOnboardingProps {
  onComplete: () => void;
  /** Debug preview: finishing does not mark the real onboarding complete. */
  preview?: boolean;
}

function useMeetingTranscriptionReady() {
  return useSettingsStore((state) => {
    const meeting = selectResolvedMeetingTranscription(state);

    if (meeting.transcriptionMode === "local") return true;

    if (meeting.transcriptionMode !== "providers") return false;

    if (meeting.cloudTranscriptionProvider === "custom")
      return !!meeting.cloudTranscriptionBaseUrl?.trim();

    return !!getTranscriptionApiKey(meeting.cloudTranscriptionProvider, state);
  });
}

function SetupStep({
  icon: Icon,
  title,
  description,
  done,
  doneLabel,
  action,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
  done: boolean;
  doneLabel: string;
  action: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3.5">
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          done ? "bg-success/15 text-success" : "bg-surface-secondary text-muted-foreground"
        )}
      >
        {done ? <Check size={16} /> : <Icon size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      {done ? (
        <span className="shrink-0 text-xs font-medium text-success">{doneLabel}</span>
      ) : (
        action
      )}
    </li>
  );
}

export default function NotesOnboarding({ onComplete, preview = false }: NotesOnboardingProps) {
  const { t } = useTranslation();
  const { isLLMConfigured, complete } = useNotesOnboarding();
  const transcriptionReady = useMeetingTranscriptionReady();

  const {
    granted: systemAudioGranted,
    mode: systemAudioMode,
    request: requestSystemAudio,
  } = useSystemAudioPermission();

  const [isRequestingSystemAudio, setIsRequestingSystemAudio] = useState(false);
  const showSystemAudio = canManageSystemAudioInApp({ mode: systemAudioMode });

  const handleGrantSystemAudio = useCallback(async () => {
    setIsRequestingSystemAudio(true);

    try {
      await requestSystemAudio();
    } finally {
      setIsRequestingSystemAudio(false);
    }
  }, [requestSystemAudio]);

  const handleComplete = () => {
    if (!preview) complete();
    onComplete();
  };

  const doneLabel = t("notes.onboarding.done");

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto px-6 py-10">
      <div className="my-auto w-full max-w-md space-y-6">
        <header className="text-center">
          <h2 className="text-lg font-semibold text-foreground">{t("notes.onboarding.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("notes.onboarding.subtitle")}</p>
        </header>

        <ol className="divide-y divide-border rounded-xl border border-border bg-surface">
          <SetupStep
            icon={Mic}
            title={t("notes.onboarding.transcription.title")}
            description={t("notes.onboarding.transcription.description")}
            done={transcriptionReady}
            doneLabel={doneLabel}
            action={
              <Button size="sm" variant="secondary" onPress={() => openSettings("models#meeting")}>
                {t("notes.onboarding.setUp")}
              </Button>
            }
          />
          <SetupStep
            icon={Sparkles}
            title={t("notes.onboarding.llm.title")}
            description={t("notes.onboarding.llm.description")}
            done={isLLMConfigured}
            doneLabel={doneLabel}
            action={
              <Button size="sm" variant="secondary" onPress={() => openSettings("models#summary")}>
                {t("notes.onboarding.setUp")}
              </Button>
            }
          />
          {showSystemAudio && (
            <SetupStep
              icon={Monitor}
              title={t("notes.onboarding.systemAudio.title")}
              description={t("notes.onboarding.systemAudio.description")}
              done={systemAudioGranted}
              doneLabel={t("notes.onboarding.systemAudio.enabled")}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  isPending={isRequestingSystemAudio}
                  onPress={() => void handleGrantSystemAudio()}
                >
                  {t("notes.onboarding.systemAudio.grant")}
                </Button>
              }
            />
          )}
        </ol>

        <div className="flex flex-col items-center gap-2">
          <Button onPress={handleComplete}>{t("notes.onboarding.getStarted")}</Button>
          <p className="text-xs text-muted-foreground">{t("notes.onboarding.laterHint")}</p>
        </div>
      </div>
    </div>
  );
}
