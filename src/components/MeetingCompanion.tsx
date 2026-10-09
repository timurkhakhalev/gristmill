import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import { Mic } from "./icons";
import { MicSlashIcon } from "./notes/MeetingMicButton";
import {
  INACTIVE_MEETING_COMPANION_STATE,
  type MeetingCompanionState,
} from "../contracts/meetingCompanion";

const BAR_COUNT = 3;

const BAR_FLOOR = 25;

// Movement past this many px turns a press into a drag instead of a click.
const DRAG_THRESHOLD_PX = 3;

// Add speech movement above the resting height so quiet system audio isn't
// hidden below a hard floor. This changes the display, never the recorded signal.
const barScale = (level: number, index: number) => {
  const phase = 0.7 + 0.3 * Math.sin(index * 1.7);

  return Math.min(100, BAR_FLOOR + Math.sqrt(level) * 180 * phase) / 100;
};

/** The app mark from assets/logo.svg, drawn in the current text color. */
function AppMark({ className }: { className?: string }) {
  return (
    <svg viewBox="20 -20 500 500" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M218 58 C110 90 30 190 38 300 C46 410 140 475 250 462 C340 450 400 380 402 290 C402 268 385 262 370 268 C355 275 345 290 340 320 C330 385 285 425 230 428 C150 432 85 375 82 290 C80 200 140 130 218 58 Z" />
      <path d="M175 300 C210 262 260 232 340 228 C372 226 392 240 396 262 C350 252 300 262 250 282 C220 294 195 300 175 300 Z" />
      <path
        d="M0 0 Q50 -28 100 0 Q50 28 0 0 Z"
        transform="translate(225 112) rotate(-52) scale(1.35)"
      />
      <path
        d="M0 0 Q50 -28 100 0 Q50 28 0 0 Z"
        transform="translate(305 100) rotate(-36) scale(1.3)"
      />
      <path
        d="M0 0 Q50 -28 100 0 Q50 28 0 0 Z"
        transform="translate(392 112) rotate(-12) scale(1.2)"
      />
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

  const micLabel = t(state.micMuted ? "meetIntegration.unmute" : "meetIntegration.mute");

  const onPointerUp = () => {
    const current = press.current;
    press.current = null;

    if (current && !current.dragging) window.electronAPI?.openMeetingCompanionNote?.();
  };

  return (
    <div className="meeting-companion-window relative flex h-screen w-screen flex-col items-center justify-start gap-1.5 pt-1.5 select-none">
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
          "flex h-16 w-8 cursor-grab flex-col items-center justify-center gap-2.5 rounded-full outline-none active:cursor-grabbing",
          "border bg-surface-2 shadow-elevated",
          warning ? "border-warning/40" : "border-border",
          "focus-visible:ring-2 focus-visible:ring-focus"
        )}
      >
        <AppMark className="size-4 text-foreground/85" />
        <span className="flex h-3 items-center gap-0.5" aria-hidden="true">
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-full w-0.5 origin-center rounded-full",
                warning ? "bg-warning" : "bg-primary"
              )}
              style={{ transform: `scaleY(${warning ? BAR_FLOOR / 100 : barScale(level, i)})` }}
            />
          ))}
        </span>
      </button>
      <button
        type="button"
        title={micLabel}
        aria-label={micLabel}
        aria-pressed={state.micMuted}
        onClick={() => window.electronAPI?.meetingCompanionToggleMic?.()}
        className={cn(
          "absolute bottom-1.5 flex size-8 items-center justify-center rounded-full outline-none",
          "border shadow-elevated focus-visible:ring-2 focus-visible:ring-focus",
          state.micMuted
            ? "border-danger/50 bg-danger text-white"
            : "border-border bg-surface-2 text-foreground/85 hover:bg-surface-2"
        )}
      >
        {state.micMuted ? <MicSlashIcon size={16} /> : <Mic size={16} />}
      </button>
    </div>
  );
}
