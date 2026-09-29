import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Square } from "../icons";
import { finishMeeting, stopRecording, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";
import { cn } from "../lib/utils";
import { formatMmSs } from "../../utils/formatDuration";
import { isControlPanelWindow } from "../../utils/windowContext";

interface MeetingRecordingPillProps {
  activeView: string;
  activeNoteId: number | null;
  onReturnToNote: () => void;
}

const BAR_COUNT = 4;
const BAR_FLOOR = 18;

const computeBarHeight = (level: number, index: number) => {
  // Per-bar phase keeps the stack from moving in lockstep at sustained levels.
  // sqrt curve maps small RMS values (typical speech ~0.05-0.1) into a
  // visible range — linear scaling kept bars clamped at the floor.
  const phase = 0.7 + 0.3 * Math.sin(index * 1.7);
  const scaled = Math.sqrt(level) * 180 * phase;
  return `${Math.max(BAR_FLOOR, Math.min(100, scaled))}%`;
};

function useElapsedSeconds(startedAt: number | null, running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running || startedAt === null) return;
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, running]);
  return elapsed;
}

/** Top-bar chip for a meeting recording while its note is not on screen. */
export default function MeetingRecordingPill({
  activeView,
  activeNoteId,
  onReturnToNote,
}: MeetingRecordingPillProps) {
  const { t } = useTranslation();
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const capturePhase = useMeetingRecordingStore((s) => s.capturePhase);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const recordingNoteTitle = useMeetingRecordingStore((s) => s.recordingNoteTitle);
  const captureStartedAt = useMeetingRecordingStore((s) => s.captureStartedAt);
  const audioLevel = useMeetingRecordingStore((s) => s.currentAudioLevel);
  const micCaptureStatus = useMeetingRecordingStore((s) => s.micCaptureStatus);
  const isWaitingForMic = micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable";
  const [isStopping, setIsStopping] = useState(false);
  const elapsed = useElapsedSeconds(captureStartedAt, isRecording);

  const isViewingRecordingNote =
    activeView === "personal-notes" && activeNoteId === recordingNoteId;

  if ((!isRecording && capturePhase !== "paused") || isViewingRecordingNote || !isControlPanelWindow()) {
    return null;
  }

  const handleStop = async () => {
    if (isStopping) return;
    setIsStopping(true);
    try {
      if (recordingNoteId) await finishMeeting();
      else await stopRecording();
    } finally {
      setIsStopping(false);
    }
  };

  const paused = capturePhase === "paused";
  const warning = paused || isWaitingForMic;
  const status = paused
    ? t("notes.editor.capture.paused")
    : isWaitingForMic
      ? t("notes.meetingPill.waitingForMicrophone")
      : formatMmSs(elapsed);
  const title = recordingNoteTitle?.trim() || t("notes.meetingPill.returnToNote");
  const returnLabel = t("notes.meetingPill.returnToNote");
  const stopLabel = t("notes.editor.capture.finishMeeting");

  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center gap-1 rounded-full ps-1 pe-1 text-xs",
        "bg-default dark:bg-white/5",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-200"
      )}
      data-no-window-drag=""
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      role="group"
      aria-label={t("notes.meeting.title")}
    >
      <button
        type="button"
        onClick={onReturnToNote}
        aria-label={returnLabel}
        title={title}
        className={cn(
          "flex h-6 min-w-0 items-center gap-2 rounded-full px-2 outline-none",
          "transition-colors duration-150 hover:bg-foreground/6",
          "focus-visible:ring-1 focus-visible:ring-focus"
        )}
      >
        <span className="flex h-3.5 shrink-0 items-center gap-0.5" aria-hidden="true">
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <span
              key={i}
              className={cn(
                "w-0.5 rounded-full transition-[height] duration-75",
                warning ? "bg-warning" : "bg-danger"
              )}
              style={{ height: warning ? `${BAR_FLOOR}%` : computeBarHeight(audioLevel, i) }}
            />
          ))}
        </span>
        <span className="min-w-0 max-w-[11rem] truncate font-medium text-foreground/85 @max-[640px]:hidden">
          {title}
        </span>
        <span className={cn("shrink-0 tabular-nums", warning ? "text-warning" : "text-muted")}>
          {status}
        </span>
      </button>
      <button
        type="button"
        onClick={handleStop}
        disabled={isStopping}
        aria-label={stopLabel}
        title={stopLabel}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full outline-none",
          "transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-focus",
          isStopping
            ? "cursor-not-allowed text-foreground/30"
            : "text-foreground/70 hover:bg-danger/12 hover:text-danger"
        )}
      >
        <Square size={10} fill="currentColor" />
      </button>
    </div>
  );
}
