import { useState, type ReactNode } from "react";
import { CircleCheck, Eye, Undo2 } from "../icons";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
// Imported (not referenced by path) so Vite fingerprints them and they resolve
// under the packaged app's file:// origin. Authored at 88px (2x the original
// 44px slot; the row has since tightened to a 40px slot), with their rounded
// corners baked in as transparency.
import microphoneIcon from "@/assets/onboarding-permission-microphone.webp";
import systemAudioIcon from "@/assets/onboarding-permission-system-audio.webp";
import type { UsePermissionsReturn } from "../../hooks/usePermissions";
import type { SystemAudioAccessResult } from "../../types/electron";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import MicPermissionWarning from "../ui/MicPermissionWarning";
import { CompactOnboardingFrame } from "./OnboardingShell";

interface CompactPermissionsStepProps {
  permissions: UsePermissionsReturn;
  systemAudio: Pick<SystemAudioAccessResult, "granted" | "mode" | "supportsOnboardingGrant"> & {
    request: () => Promise<boolean>;
  };
  /** Omitted when there is no step to return to. */
  onBack?: () => void;
  onContinue: () => void;
}

type PermissionRowId = "microphone" | "system-audio" | "accessibility";

interface PermissionRowProps {
  title: string;
  description: string;
  badge?: string;
  granted: boolean;
  busy: boolean;
  disabled?: boolean;
  actionLabel?: string;
  iconSrc?: string;
  icon?: ReactNode;
  onRequest: () => Promise<void>;
}

function PermissionRow({
  title,
  description,
  badge,
  granted,
  busy,
  disabled = false,
  actionLabel,
  iconSrc,
  icon,
  onRequest,
}: PermissionRowProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-16 items-center gap-3">
      {/* Decorative: the adjacent title and description already name the
          permission, so announcing the icon too would just duplicate it. The
          icon stays put once granted — the button carries the state. */}
      {icon ?? (
        <img
          src={iconSrc}
          alt=""
          aria-hidden="true"
          width={40}
          height={40}
          decoding="async"
          draggable={false}
          className="size-10 shrink-0 select-none"
        />
      )}

      <div className="min-w-0 flex-1 text-start">
        <p className="text-sm font-medium leading-5 text-[var(--onboarding-text-primary)]">
          {title}
          {badge && (
            <span className="ms-1.5 inline-flex items-center rounded-full bg-[var(--onboarding-surface-tertiary)] px-2 py-0.5 align-middle text-2xs font-normal leading-4 text-[var(--onboarding-text-secondary)]">
              {badge}
            </span>
          )}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-[var(--onboarding-text-secondary)]">
          {description}
        </p>
      </div>

      <button
        type="button"
        disabled={busy || disabled || granted}
        onClick={() => void onRequest()}
        className={`onboarding-pressable inline-flex h-8 min-w-20 shrink-0 items-center justify-center gap-1 rounded-full px-2.5 text-xs font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_30%,transparent)] disabled:cursor-default ${
          granted
            ? // Granted rows are disabled, so the disabled: variants have to
              // restate the tint or it falls back to the neutral grey below.
              "bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] text-[var(--onboarding-accent)] disabled:bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] disabled:text-[var(--onboarding-accent)]"
            : "bg-[var(--onboarding-surface-tertiary)] text-[var(--onboarding-text-secondary)] hover:bg-[var(--onboarding-surface-tertiary-hover)] disabled:bg-[var(--onboarding-surface-tertiary)] disabled:text-[var(--onboarding-text-secondary)]"
        }`}
      >
        {granted && !busy && <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />}
        {busy
          ? t("common.loading")
          : granted
            ? t("onboarding.rehaul.permissions.enabled")
            : (actionLabel ?? t("onboarding.rehaul.permissions.enable"))}
      </button>
    </div>
  );
}

export default function CompactPermissionsStep({
  permissions,
  systemAudio,
  onBack,
  onContinue,
}: CompactPermissionsStepProps) {
  const { t } = useTranslation();
  const [busyPermission, setBusyPermission] = useState<PermissionRowId | null>(null);
  const canRequestSystemAudio = canManageSystemAudioInApp(systemAudio);
  const requiredGranted = permissions.micPermissionGranted;

  const request = async (id: PermissionRowId, action: () => Promise<void | boolean>) => {
    setBusyPermission(id);

    try {
      await action();
    } finally {
      setBusyPermission(null);
    }
  };

  return (
    <CompactOnboardingFrame>
      <div className="onboarding-shell-scroll relative flex h-full flex-col overflow-y-auto px-5 pb-6 pt-45 text-center">
        {/* text-balance evens the two lines out ("Set up Gristmill" / "in 3
            minutes") instead of leaving one word stranded. Preferred over a
            hardcoded <br> because the break point stays correct in all 9
            locales, where the string length differs. */}
        <h1 className="onboarding-display-title mx-auto max-w-72 text-balance text-3xl!">
          {t("onboarding.rehaul.permissions.title")}
        </h1>
        <p className="mt-2 text-sm text-[var(--onboarding-text-secondary)]">
          {t("onboarding.rehaul.permissions.microphoneDescription")}
        </p>

        <div className="mt-3 rounded-[1.35rem] bg-[var(--onboarding-surface-secondary)] px-3 py-1">
          <PermissionRow
            title={t("onboarding.permissions.microphoneTitle")}
            description={t("onboarding.rehaul.permissions.microphoneDescription")}
            granted={permissions.micPermissionGranted}
            busy={busyPermission === "microphone"}
            iconSrc={microphoneIcon}
            onRequest={() => request("microphone", permissions.requestMicPermission)}
          />
          {
            <>
              <div className="h-px bg-[var(--onboarding-surface-tertiary)]" />
              <PermissionRow
                title={t("onboarding.rehaul.permissions.systemAudioTitle")}
                description={t("onboarding.rehaul.permissions.systemAudioDescription")}
                badge={t("onboarding.permissions.optional")}
                granted={systemAudio.granted}
                busy={busyPermission === "system-audio"}
                disabled={!canRequestSystemAudio}
                iconSrc={systemAudioIcon}
                onRequest={() => request("system-audio", systemAudio.request)}
              />
            </>
          }
          <div className="h-px bg-[var(--onboarding-surface-tertiary)]" />
          <PermissionRow
            title={t("hooks.permissions.settingsTitles.accessibility")}
            description={t(
              permissions.accessibilityTroubleshooting
                ? "cleanupSettings.accessibilityHelp"
                : "cleanupSettings.accessibilityDetection"
            )}
            badge={t("onboarding.permissions.optional")}
            granted={permissions.accessibilityPermissionGranted}
            busy={busyPermission === "accessibility"}
            actionLabel={
              permissions.accessibilityPromptRequested
                ? t("cleanupSettings.openSettings")
                : undefined
            }
            icon={
              <Eye
                className="size-10 shrink-0 p-2 text-[var(--onboarding-text-secondary)]"
                aria-hidden="true"
              />
            }
            onRequest={() => request("accessibility", permissions.requestAccessibilityPermission)}
          />
        </div>

        {!permissions.micPermissionGranted && permissions.micPermissionError && (
          <div className="mt-3 text-start">
            <MicPermissionWarning
              error={permissions.micPermissionError}
              onOpenSoundSettings={() => void permissions.openSoundInputSettings()}
              onOpenPrivacySettings={() => void permissions.openMicPrivacySettings()}
            />
          </div>
        )}

        <div className="mt-auto flex w-full shrink-0 items-center justify-between gap-3 pt-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="onboarding-pressable inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-5 text-sm font-medium text-[var(--onboarding-text-primary)] transition-colors hover:bg-[var(--onboarding-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_30%,transparent)]"
            >
              <Undo2 className="size-4" aria-hidden="true" />
              {t("common.back")}
            </button>
          )}

          <Button
            type="button"
            onClick={onContinue}
            disabled={!requiredGranted}
            className="h-10 flex-1 px-5 text-sm"
          >
            {t("common.continue")}
          </Button>
        </div>
      </div>
    </CompactOnboardingFrame>
  );
}
