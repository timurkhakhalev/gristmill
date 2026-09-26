import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import {
  INACTIVE_MEETING_COMPANION_STATE,
  type MeetingCompanionState,
} from "../contracts/meetingCompanion";

const BAR_COUNT = 3;
const BAR_FLOOR = 25;
// Movement past this many px turns a press into a drag instead of a click.
const DRAG_THRESHOLD_PX = 3;

// Same curve as the in-app recording pill: sqrt lifts speech-level RMS into view,
// the per-bar phase keeps the bars from moving in lockstep.
const barHeight = (level: number, index: number) => {
  const phase = 0.7 + 0.3 * Math.sin(index * 1.7);
  return `${Math.max(BAR_FLOOR, Math.min(100, Math.sqrt(level) * 180 * phase))}%`;
};

/** The app mark from assets/logo.svg, drawn in the current text color. */
function AppMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" fill="none" aria-hidden="true" className={className}>
      <g stroke="currentColor" strokeWidth="96" strokeLinecap="round">
        <circle cx="512" cy="512" r="400" />
        <path d="M512 360V664M650 450V574M374 450V574" />
      </g>
    </svg>
  );
}

/** Contents of the always-on-top recording bubble window: drag to move, click to open the note. */
export default function MeetingCompanion() {
  const { t } = useTranslation();
  const [state, setState] = useState<MeetingCompanionState>(INACTIVE_MEETING_COMPANION_STATE);
  const [level, setLevel] = useState(0);
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  useEffect(() => {
    const resetPress = () => {
      press.current = null;
    };
    window.addEventListener("blur", resetPress);
    return () => window.removeEventListener("blur", resetPress);
  }, []);

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
    // The window hides mid-gesture when the click brings the app forward, so a
    // pointerup can go missing; never drag without the button actually held.
    if ((e.buttons & 1) === 0) {
      press.current = null;
      return;
    }
    if (
      !current.dragging &&
      Math.hypot(e.screenX - current.x, e.screenY - current.y) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    current.dragging = true;
    window.electronAPI?.meetingCompanionDragMove?.(e.screenX, e.screenY);
  };

  const resetPress = () => {
    press.current = null;
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
        onPointerCancel={resetPress}
        onLostPointerCapture={resetPress}
        className={cn(
          "flex h-[88px] w-10 cursor-grab flex-col items-center justify-center gap-3 rounded-full outline-none active:cursor-grabbing",
          "border bg-surface-2/95 shadow-elevated backdrop-blur-xl",
          warning ? "border-warning/40" : "border-border",
          "focus-visible:ring-2 focus-visible:ring-focus"
        )}
      >
        <AppMark className="size-5 text-foreground/85" />
        <span className="flex h-4 items-center gap-0.75" aria-hidden="true">
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
