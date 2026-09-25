import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { AudioLines, Loader2, Mic, Play, Square } from "../icons";
import { Pause } from "../icons/primitives";
import { formatMmSs } from "../../utils/formatDuration";

export function RecordingWave({ className = "" }: { className?: string }) {
  return <AudioLines size={14} className={className} aria-hidden="true" />;
}

export default function NoteRecordControl({ isRecording, isProcessing, capturePhase, captureStartedAt, disabled = false, onStart, onStop, onPause, onResume }: {
  isRecording: boolean;
  isProcessing: boolean;
  capturePhase: "idle" | "preparing" | "recording" | "paused" | "saving" | "saved" | "incomplete" | "failed";
  captureStartedAt: number | null;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause?: () => void;
  onResume?: () => void;
}) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRecording || captureStartedAt === null) return;
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - captureStartedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [isRecording, captureStartedAt]);

  if (capturePhase === "preparing" || capturePhase === "saving") return <div className="oh-capture-control"><Loader2 size={14} className="animate-spin" />{t(`notes.editor.capture.${capturePhase}`)}</div>;
  if (isRecording || capturePhase === "paused") return <div className="oh-capture-control" role="group" aria-label={t("notes.meeting.title")}>
    <span className={`oh-record-dot ${capturePhase === "paused" ? "oh-record-dot-paused" : ""}`} />
    <strong className="tabular-nums">{capturePhase === "paused" ? t("notes.editor.capture.paused", { defaultValue: "Paused" }) : formatMmSs(elapsed)}</strong>
    <Button isIconOnly size="sm" variant="ghost" aria-label={capturePhase === "paused" ? t("notes.editor.capture.resume", { defaultValue: "Resume recording" }) : t("notes.editor.capture.pause", { defaultValue: "Pause recording" })} onPress={capturePhase === "paused" ? onResume : onPause}>{capturePhase === "paused" ? <Play size={16} /> : <Pause size={16} />}</Button>
    <Button size="sm" variant="secondary" onPress={onStop}><Square size={13} />{t("notes.editor.capture.finishMeeting", { defaultValue: "End call" })}</Button>
  </div>;
  return <Button size="sm" isDisabled={disabled || isProcessing} onPress={onStart}><Mic size={16} />{t("notes.editor.startRecording")}</Button>;
}
