import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic } from "../icons";
import { cn } from "../lib/utils";
import { setManualMicMuted, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";

/** Microphone glyph with a slash through it; the unmuted state is the plain Mic. */
export function MicSlashIcon({ size = 14 }: { size?: number }) {
  return (
    <span className="relative inline-flex">
      <Mic size={size} />
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className="absolute inset-0"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      >
        <path d="M3.5 3.5 20.5 20.5" />
      </svg>
    </span>
  );
}

export function MeetingMicButton() {
  const { t } = useTranslation();
  const muted = useMeetingRecordingStore((s) => s.manualMicMuted);
  const platformMuted = useMeetingRecordingStore((s) => s.platformMicMuted);
  const phase = useMeetingRecordingStore((s) => s.capturePhase);
  // Target state while the gate transition is in flight, so the button reacts at once.
  const [pending, setPending] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);

  if (phase !== "recording" && phase !== "paused") return null;
  const label = t(muted ? "meetIntegration.unmute" : "meetIntegration.mute");
  const effectiveMuted = pending ?? (muted || platformMuted);

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-busy={pending !== null}
        aria-label={label}
        aria-pressed={muted}
        title={platformMuted ? `${label} · ${t("meetIntegration.platformMuted")}` : label}
        className={cn(
          "flex size-7 items-center justify-center rounded-md outline-none transition-colors",
          "focus-visible:ring-1 focus-visible:ring-focus",
          effectiveMuted
            ? "bg-danger/15 text-danger hover:bg-danger/25"
            : "text-foreground/70 hover:bg-foreground/10"
        )}
        onClick={async () => {
          if (pending !== null) return;
          setPending(!muted);

          try {
            setFailed(!(await setManualMicMuted(!muted)));
          } finally {
            setPending(null);
          }
        }}
      >
        {effectiveMuted ? <MicSlashIcon /> : <Mic size={14} />}
      </button>
      {failed && (
        <span role="alert" className="text-xs text-danger">
          {t("meetIntegration.muteFailed")}
        </span>
      )}
    </span>
  );
}
