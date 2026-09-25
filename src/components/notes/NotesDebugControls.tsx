import { useState } from "react";
import { Bug, Check } from "../icons";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export type NotesDebugScenario =
  | "onboarding"
  | "empty"
  | "blank"
  | "manual"
  | "transcript"
  | "ready"
  | "queued"
  | "processing"
  | "blocked"
  | "failed"
  | "summary-failed"
  | "incomplete"
  | "audio-deleted"
  | "enhanced-stale"
  | "capture-preparing"
  | "recording"
  | "paused"
  | "reconnecting"
  | "system-unavailable"
  | "capture-saving"
  | "capture-failed";

const scenarios: { id: NotesDebugScenario; label: string }[] = [
  { id: "onboarding", label: "Setup checklist" },
  { id: "empty", label: "Empty Notes" },
  { id: "blank", label: "Blank note" },
  { id: "manual", label: "Manual note" },
  { id: "transcript", label: "Transcript ready" },
  { id: "ready", label: "Summary ready" },
  { id: "enhanced-stale", label: "Enhanced note stale" },
  { id: "queued", label: "Processing queued" },
  { id: "processing", label: "Processing running" },
  { id: "blocked", label: "Processing blocked" },
  { id: "failed", label: "Transcription failed" },
  { id: "summary-failed", label: "Summary failed" },
  { id: "incomplete", label: "Incomplete capture" },
  { id: "audio-deleted", label: "Audio deleted" },
  { id: "capture-preparing", label: "Capture preparing" },
  { id: "recording", label: "Recording UI" },
  { id: "paused", label: "Recording paused" },
  { id: "reconnecting", label: "System audio reconnecting" },
  { id: "system-unavailable", label: "System audio unavailable" },
  { id: "capture-saving", label: "Capture saving" },
  { id: "capture-failed", label: "Capture failed" },
];

export default function NotesDebugControls({
  scenario,
  onChange,
}: {
  scenario: NotesDebugScenario | null;
  onChange: (scenario: NotesDebugScenario | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Notes debug states"
          title="Notes debug states"
          className="flex h-8 items-center gap-1.5 rounded-lg border border-orange-500/35 bg-orange-500/10 px-2.5 text-xs font-medium text-orange-700 hover:bg-orange-500/15 dark:text-orange-300"
        >
          <Bug size={14} /> Debug
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 max-h-[min(75vh,560px)] overflow-y-auto">
        <p className="px-2 py-1 text-xs font-semibold">Notes state preview</p>
        <p className="px-2 pb-2 text-2xs text-muted-foreground">
          Interactive in-memory states. No audio or provider calls.
        </p>
        <div role="group" aria-label="Notes state preview" className="space-y-0.5">
          {[{ id: null, label: "Live app" }, ...scenarios].map(({ id, label }) => (
            <button
              key={id ?? "live"}
              type="button"
              aria-pressed={scenario === id}
              onClick={() => {
                onChange(id as NotesDebugScenario | null);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-default"
            >
              {label}
              {scenario === id && <Check size={13} />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
