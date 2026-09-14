import { useTranslation } from "react-i18next";
import { KeyRound, Laptop, Server, Zap } from "../icons";

type OnboardingSetupMode = "byok" | "local";

interface SetupChoiceStepProps {
  onSelect: (mode: Exclude<OnboardingSetupMode, null>, options?: { selfHosted?: boolean }) => void;
}

/** Choose a local or user-managed provider path. */
export default function SetupChoiceStep({ onSelect }: SetupChoiceStepProps) {
  const { t } = useTranslation();
  const cards = [
    {
      id: "local" as const,
      selfHosted: false,
      icon: Laptop,
      title: t("onboarding.rehaul.setupChoice.local.title"),
      description: t("onboarding.rehaul.setupChoice.local.description"),
    },
    {
      id: "byok" as const,
      selfHosted: false,
      icon: KeyRound,
      title: t("onboarding.rehaul.setupChoice.byok.title"),
      description: t("onboarding.rehaul.setupChoice.byok.description"),
    },
    {
      id: "byok" as const,
      selfHosted: true,
      icon: Server,
      title: t("onboarding.rehaul.setupChoice.moreOptions.selfHosted.title"),
      description: t("onboarding.rehaul.setupChoice.moreOptions.selfHosted.description"),
    },
  ];

  return (
    <div className="mx-auto mt-5 grid w-full max-w-3xl gap-3 sm:grid-cols-3">
      {cards.map(({ id, icon: Icon, title, description, selfHosted }) => (
        <button
          key={selfHosted ? "self-hosted" : id}
          type="button"
          onClick={() => onSelect(id, { selfHosted })}
          className="flex min-h-44 flex-col rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] p-4 text-start transition-colors hover:bg-[var(--onboarding-surface-hover)]"
        >
          <Icon className="size-5 text-[var(--onboarding-accent)]" />
          <span className="mt-4 text-sm font-medium text-[var(--onboarding-text-primary)]">{title}</span>
          <span className="mt-1 text-xs leading-5 text-[var(--onboarding-text-secondary)]">{description}</span>
          <span className="mt-auto flex items-center gap-1 pt-4 text-xs font-medium text-[var(--onboarding-accent)]">
            <Zap className="size-3.5" />
            {t("onboarding.rehaul.setupChoice.continueSetup")}
          </span>
        </button>
      ))}
    </div>
  );
}
