import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import {
  INACTIVE_MEETING_COMPANION_STATE,
  type MeetingCompanionState,
} from "../contracts/meetingCompanion";

const BAR_COUNT = 4;
const BAR_FLOOR = 18;
// Movement past this many px turns a press into a drag instead of a click.
const DRAG_THRESHOLD_PX = 3;

// Same curve as the in-app recording pill: sqrt lifts speech-level RMS into view,
// the per-bar phase keeps the bars from moving in lockstep.
const barHeight = (level: number, index: number) => {
  const phase = 0.7 + 0.3 * Math.sin(index * 1.7);
  return `${Math.max(BAR_FLOOR, Math.min(100, Math.sqrt(level) * 180 * phase))}%`;
};

/** Contents of the always-on-top recording bubble window: drag to move, click to open the note. */
export default function MeetingCompanion() {
  const { t } = useTranslation();
  const [state, setState] = useState<MeetingCompanionState>(INACTIVE_MEETING_COMPANION_STATE);
  const [level, setLevel] = useState(0);
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    const offState = api?.onMeetingCompanionState?.(setState);
    const offLevel = api?.onMeetingCompanionLevel?.(setLevel);
    api?.meetingCompanionReady?.();
    return () => {
      offState?.();
      offLevel?.();
    };
  }, []);

  const warning = state.paused || state.waitingForMic;
  const label = state.paused
    ? t("notes.editor.capture.paused")
    : state.waitingForMic
      ? t("notes.meetingPill.waitingForMicrophone")
      : state.title || t("notes.meetingPill.returnToNote");

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.screenX, y: e.screenY, dragging: false };
    window.electronAPI?.meetingCompanionDragStart?.(e.screenX, e.screenY);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (!current) return;
    if (
      !current.dragging &&
      Math.hypot(e.screenX - current.x, e.screenY - current.y) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    current.dragging = true;
    window.electronAPI?.meetingCompanionDragMove?.(e.screenX, e.screenY);
  };

  const onPointerUp = () => {
    const current = press.current;
    press.current = null;
    if (current && !current.dragging) window.electronAPI?.openMeetingCompanionNote?.();
  };

  return (
    <div className="meeting-companion-window flex h-screen w-screen items-center justify-center select-none">
      <button
        type="button"
        title={label}
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null;
        }}
        className={cn(
          "relative flex size-12 cursor-grab items-center justify-center rounded-full outline-none active:cursor-grabbing",
          "border bg-surface-2/95 shadow-elevated backdrop-blur-xl",
          warning ? "border-warning/40" : "border-primary/30",
          "focus-visible:ring-2 focus-visible:ring-focus"
        )}
      >
        {/* A halo that swells with the voice, so the bubble reads as "listening" at a glance. */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-0 rounded-full transition-transform duration-100 ease-out",
            warning ? "bg-warning/15" : "bg-primary/15"
          )}
          style={{ transform: `scale(${1 + Math.min(0.25, Math.sqrt(level) * 0.6)})` }}
        />
        <span className="relative flex h-5 items-center gap-0.75" aria-hidden="true">
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <span
              key={i}
              className={cn(
                "w-0.75 rounded-full transition-[height] duration-75",
                warning ? "bg-warning" : "bg-primary"
              )}
              style={{ height: warning ? `${BAR_FLOOR}%` : barHeight(level, i) }}
            />
          ))}
        </span>
      </button>
    </div>
  );
}
