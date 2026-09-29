import { ProfileNameField } from "./settings/ProfileNameField";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/usePermissions";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useSettingsStore } from "../stores/settingsStore";
import CompactPermissionsStep from "./onboarding/CompactPermissionsStep";
import CalendarConnectionsStep from "./onboarding/CalendarConnectionsStep";
import LanguageSelectionStep from "./onboarding/LanguageSelectionStep";
import { ByokProviderStep } from "./onboarding/ProviderSetupStep";
import { OnboardingStepHeader, CompactOnboardingFrame } from "./onboarding/OnboardingShell";
import { Button } from "./ui/button";

interface OnboardingFlowProps {
  onComplete: (options?: { openSettings?: boolean }) => void;
}

type Step = "profile" | "permissions" | "provider" | "languages" | "calendar";

/** Small, product-focused setup flow: recording permissions, one provider,
 * spoken languages, and an optional calendar connection. */
export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("permissions");
  const [providerConnected, setProviderConnected] = useState(false);
  const store = useSettingsStore();
  const [languages, setLanguages] = useState<string[]>(store.spokenLanguages ?? []);
  const permissions = usePermissions();
  const systemAudio = useSystemAudioPermission();

  const finish = () => {
    localStorage.setItem("onboardingCompleted", "true");
    onComplete();
  };

  if (step === "permissions") {
    return (
      <CompactPermissionsStep
        permissions={permissions}
        systemAudio={systemAudio}
        onContinue={() => setStep("profile")}
      />
    );
  }

  return (
    <CompactOnboardingFrame>
      <div className={`onboarding-shell-scroll flex h-full flex-col overflow-y-auto px-6 pb-6 ${step === "profile" ? "pt-45" : "pt-24"}`}>
        {step === "profile" && (
          <>
            <OnboardingStepHeader title={t("profile.onboardingTitle")} />
            <div className="mt-6"><ProfileNameField /></div>
            <Footer back={() => setStep("permissions")} onContinue={() => setStep("provider")}
              continueLabel={store.profileName.trim() ? t("common.continue") : t("profile.skip")} />
          </>
        )}
        {step === "provider" && (
          <>
            <OnboardingStepHeader
              title={t("onboarding.rehaul.provider.title")}
              description={t("onboarding.rehaul.provider.description")}
            />
            <div className="mt-6 flex min-h-0 flex-1 flex-col">
              <ByokProviderStep
                onSelfHostedChange={() => {}}
                onConnectionChange={setProviderConnected}
                onProceed={() => setStep("languages")}
              />
            </div>
            <Button variant="ghost" onClick={() => setStep("languages")}>{t("cleanupSettings.configureLater")}</Button>
            <Footer
              back={() => setStep("profile")}
              continueDisabled={!providerConnected}
              onContinue={() => setStep("languages")}
            />
          </>
        )}
        {step === "languages" && (
          <>
            <OnboardingStepHeader
              title={t("onboarding.rehaul.languages.title")}
              description={t("onboarding.rehaul.languages.description")}
            />
            <LanguageSelectionStep
              selected={languages}
              onChange={(next) => {
                setLanguages(next);
                store.setSpokenLanguages(next);
              }}
              searchPlaceholder={t("languageSelector.searchPlaceholder")}
              noResultsLabel={t("languageSelector.noLanguagesFound")}
              selectedLabel={t("onboarding.rehaul.languages.selected")}
            />
            <Footer back={() => setStep("provider")} onContinue={() => setStep("calendar")} />
          </>
        )}
        {step === "calendar" && (
          <>
            <OnboardingStepHeader
              title={t("onboarding.rehaul.notes.title")}
              description={t("onboarding.rehaul.notes.description")}
            />
            <div className="mt-6 flex min-h-0 flex-1 flex-col">
              <CalendarConnectionsStep />
            </div>
            <Footer back={() => setStep("languages")} onContinue={finish} continueLabel={t("common.finish")} />
          </>
        )}
      </div>
    </CompactOnboardingFrame>
  );
}

function Footer({
  back,
  onContinue,
  continueDisabled = false,
  continueLabel,
}: {
  back: () => void;
  onContinue: () => void;
  continueDisabled?: boolean;
  continueLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-auto flex w-full shrink-0 gap-3 pt-6">
      <Button type="button" variant="outline-flat" onClick={back} className="h-10 flex-1">
        {t("common.back")}
      </Button>
      <Button type="button" onClick={onContinue} disabled={continueDisabled} className="h-10 flex-1">
        {continueLabel ?? t("common.continue")}
      </Button>
    </div>
  );
}
