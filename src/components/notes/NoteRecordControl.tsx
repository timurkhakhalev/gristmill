import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button, Tooltip } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, AudioLines, Loader2, Mic, Play, Sparkles, Square } from "../icons";
import { Pause } from "../icons/primitives";
import { formatMmSs } from "../../utils/formatDuration";
import { IconTooltip } from "../ui/IconTooltip";

export function RecordingWave({ className = "" }: { className?: string }) {
  return <AudioLines size={14} className={className} aria-hidden="true" />;
}

export default function NoteRecordControl({
  isRecording,
  isProcessing,
  isGeneratingSummary,
  capturePhase,
  captureStartedAt,
  captureDetails,
  disabled = false,
  showSummaryAction = false,
  onStart,
  onStop,
  onPause,
  onResume,
  onGenerateSummary,
}: {
  isRecording: boolean;
  isProcessing: boolean;
  /** True while an AI summary request is in flight; the summary action gets a spinner. */
  isGeneratingSummary?: boolean;
  capturePhase:
    | "idle"
    | "preparing"
    | "recording"
    | "paused"
    | "saving"
    | "saved"
    | "incomplete"
    | "failed";
  captureStartedAt: number | null;
  captureDetails?: ReactNode;
  disabled?: boolean;
  /** Show the "Create summary" pill only when the transcript is ready and no summary exists. */
  showSummaryAction?: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onGenerateSummary?: () => void;
}) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRecording || captureStartedAt === null) return;

    const update = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - captureStartedAt) / 1000)));

    update();
    const timer = window.setInterval(update, 1000);

    return () => window.clearInterval(timer);
  }, [isRecording, captureStartedAt]);

  const pauseLabel =
    capturePhase === "paused"
      ? t("notes.editor.capture.resume", { defaultValue: "Resume recording" })
      : t("notes.editor.capture.pause", { defaultValue: "Pause recording" });

  const stopLabel = t("notes.editor.capture.finishMeeting", { defaultValue: "End call" });

  const indicator = (
    <Tooltip delay={400} closeDelay={0}>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 min-h-8 gap-1.5 px-0 text-sm cursor-help"
        aria-label={t("notes.editor.capture.details", { defaultValue: "Recording details" })}
      >
        {capturePhase === "preparing" || capturePhase === "saving" ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            {t(`notes.editor.capture.${capturePhase}`)}
          </>
        ) : (
          <>
            <span
              aria-hidden="true"
              className={`size-[7px] rounded-full ${capturePhase === "paused" ? "bg-warning" : "bg-danger motion-safe:animate-pulse"}`}
            />
            <strong className="tabular-nums">
              {capturePhase === "paused"
                ? t("notes.editor.capture.paused", { defaultValue: "Paused" })
                : formatMmSs(elapsed)}
            </strong>
          </>
        )}
      </Button>
      <Tooltip.Content className="max-w-80 whitespace-normal p-3 text-xs">
        {captureDetails}
      </Tooltip.Content>
    </Tooltip>
  );

  if (capturePhase === "preparing" || capturePhase === "saving")
    return (
      <div className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-default px-3 text-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
        {indicator}
      </div>
    );

  if (isRecording || capturePhase === "paused")
    return (
      <div
        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-default ps-3 pe-0.5 text-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 motion-safe:zoom-in-95"
        role="group"
        aria-label={t("notes.meeting.title")}
      >
        {indicator}
        <IconTooltip label={pauseLabel}>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            className="size-7 min-h-7"
            aria-label={pauseLabel}
            onPress={capturePhase === "paused" ? onResume : onPause}
          >
            {capturePhase === "paused" ? <Play size={16} /> : <Pause size={16} />}
          </Button>
        </IconTooltip>
        <IconTooltip label={stopLabel}>
          <Button
            isIconOnly
            size="sm"
            variant="secondary"
            className="size-7 min-h-7"
            aria-label={stopLabel}
            onPress={onStop}
          >
            <Square size={13} />
          </Button>
        </IconTooltip>
      </div>
    );

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
        isDisabled={disabled || isProcessing}
        onPress={onStart}
      >
        <Mic size={16} />
        <span className="@max-[620px]:sr-only">
          {t("notes.editor.record", { defaultValue: "Record" })}
        </span>
      </Button>
      {showSummaryAction && (
        <Button
          size="sm"
          variant="secondary"
          isPending={Boolean(isGeneratingSummary)}
          isDisabled={Boolean(isGeneratingSummary)}
          onPress={() => onGenerateSummary?.()}
          className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
          aria-label={t("notes.editor.generateSummary", { defaultValue: "Summary" })}
        >
          {!isGeneratingSummary && <Sparkles size={16} className="text-accent" />}
          <span className="@max-[620px]:sr-only">
            {t("notes.editor.generateSummary", { defaultValue: "Summary" })}
          </span>
        </Button>
      )}
    </div>
  );
}
