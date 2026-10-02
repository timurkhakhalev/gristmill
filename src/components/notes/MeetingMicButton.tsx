import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic } from "../icons";
import { setManualMicMuted, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";

export function MeetingMicButton() {
  const { t } = useTranslation();
  const muted = useMeetingRecordingStore((s) => s.manualMicMuted);
  const platformMuted = useMeetingRecordingStore((s) => s.platformMicMuted);
  const phase = useMeetingRecordingStore((s) => s.capturePhase);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (phase !== "recording" && phase !== "paused") return null;
  const label = t(muted ? "meetIntegration.unmute" : "meetIntegration.mute");
  const effectiveMuted = muted || platformMuted;
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        aria-label={label}
        aria-pressed={muted}
        title={platformMuted ? `${label} · ${t("meetIntegration.platformMuted")}` : label}
        className="flex size-7 items-center justify-center rounded-md text-foreground/70 hover:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-40"
        onClick={async () => {
          setBusy(true);
          try {
            setFailed(!(await setManualMicMuted(!muted)));
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="relative">
          <Mic size={14} />
          {effectiveMuted && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-px w-4 -rotate-45 bg-current"
            />
          )}
        </span>
      </button>
      {failed && (
        <span role="alert" className="text-xs text-danger">
          {t("meetIntegration.muteFailed")}
        </span>
      )}
    </span>
  );
}
