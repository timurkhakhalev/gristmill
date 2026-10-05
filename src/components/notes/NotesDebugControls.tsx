import { useState } from "react";
import { Bug, Check, ChevronDown, ChevronRight } from "../icons";
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
  | "processing-elapsed-short"
  | "processing-elapsed-long"
  | "blocked"
  | "failed"
  | "summary-failed"
  | "summary-generating"
  | "incomplete"
  | "audio-deleted"
  | "enhanced-stale"
  | "capture-preparing"
  | "recording"
  | "paused"
  | "reconnecting"
  | "system-unavailable"
  | "capture-saving"
  | "capture-failed"
  | "gate-waiting"
  | "naming"
  | "audio-playing"
  | "audio-paused"
  | "short-meeting"
  | "speakers-auto"
  | "summary-tasks-loading"
  | "summary-tasks-ok"
  | "summary-tasks-zero"
  | "summary-tasks-error"
  | "summary-tasks-format"
  | "summary-tasks-conflict"
  | "summary-recap-running"
  | "summary-recap"
  | "chat-follow-up";

const scenarioGroups: {
  id: string;
  label: string;
  items: { id: NotesDebugScenario; label: string }[];
}[] = [
  {
    id: "setup",
    label: "Setup and notes",
    items: [
      { id: "onboarding", label: "Setup checklist" },
      { id: "empty", label: "Empty Notes" },
      { id: "blank", label: "Blank note" },
      { id: "manual", label: "Manual note" },
    ],
  },
  {
    id: "capture",
    label: "Recording",
    items: [
      { id: "capture-preparing", label: "Capture preparing" },
      { id: "recording", label: "Recording UI" },
      { id: "paused", label: "Recording paused" },
      { id: "reconnecting", label: "System audio reconnecting" },
      { id: "system-unavailable", label: "System audio unavailable" },
      { id: "capture-saving", label: "Capture saving" },
      { id: "capture-failed", label: "Capture failed" },
      { id: "incomplete", label: "Incomplete capture" },
    ],
  },
  {
    id: "processing",
    label: "Processing",
    items: [
      { id: "queued", label: "Queued" },
      { id: "processing", label: "Running" },
      { id: "processing-elapsed-short", label: "Running · just started" },
      { id: "processing-elapsed-long", label: "Running · 2 min in" },
      { id: "blocked", label: "Blocked" },
      { id: "failed", label: "Transcription failed" },
      { id: "summary-generating", label: "Summary generating" },
      { id: "summary-failed", label: "Summary failed" },
    ],
  },
  {
    id: "results",
    label: "Results",
    items: [
      { id: "transcript", label: "Transcript ready" },
      { id: "ready", label: "Summary ready" },
      { id: "enhanced-stale", label: "Enhanced note stale" },
      { id: "audio-deleted", label: "Audio deleted" },
    ],
  },
  {
    id: "task2-pipeline",
    label: "Task 2 · After the meeting",
    items: [
      { id: "gate-waiting", label: "15 s wait before transcription" },
      { id: "naming", label: "Identifying speakers" },
      { id: "audio-playing", label: "Audio part playing" },
      { id: "audio-paused", label: "Audio part paused" },
      { id: "short-meeting", label: "Short meeting, no auto Summary" },
    ],
  },
  {
    id: "task2-summary",
    label: "Task 2 · Summary and tasks",
    items: [
      { id: "summary-tasks-loading", label: "Tasks loading" },
      { id: "summary-tasks-ok", label: "HIGH / MEDIUM / LOW" },
      { id: "summary-tasks-zero", label: "No tasks" },
      { id: "summary-tasks-error", label: "Tasks failed" },
      { id: "summary-tasks-format", label: "Custom prompt format" },
      { id: "summary-tasks-conflict", label: "Edit conflict" },
      { id: "summary-recap-running", label: "Recap running" },
      { id: "summary-recap", label: "Recap added" },
    ],
  },
  {
    id: "task2-people",
    label: "Task 2 · Speakers and Chat",
    items: [
      { id: "speakers-auto", label: "Auto speaker names" },
      { id: "chat-follow-up", label: "Follow-up in Chat" },
    ],
  },
];

export default function NotesDebugControls({
  scenario,
  onChange,
}: {
  scenario: NotesDebugScenario | null;
  onChange: (scenario: NotesDebugScenario | null) => void;
}) {
  const [open, setOpen] = useState(false);

  const activeGroup = scenarioGroups.find((group) =>
    group.items.some((item) => item.id === scenario)
  )?.id;

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(activeGroup ? [activeGroup] : [])
  );

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);

      if (!next.delete(id)) next.add(id);

      return next;
    });

  const select = (id: NotesDebugScenario | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Notes debug states"
          title="Notes debug states"
          className="flex h-8 items-center gap-1.5 rounded-lg border border-orange-500/35 bg-orange-500/10 px-2.5 text-xs font-medium text-orange-700 hover:bg-orange-500/15 dark:text-orange-300 @max-[560px]:w-8 @max-[560px]:justify-center @max-[560px]:gap-0 @max-[560px]:px-0"
        >
          <Bug size={14} /> <span className="@max-[560px]:hidden">Debug</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 max-h-[min(75vh,560px)] overflow-y-auto">
        <p className="px-2 py-1 text-xs font-semibold">Notes state preview</p>
        <p className="px-2 pb-2 text-2xs text-muted-foreground">
          Interactive in-memory states. No audio or provider calls.
        </p>
        <div role="group" aria-label="Notes state preview" className="space-y-0.5">
          <button
            type="button"
            aria-pressed={scenario === null}
            onClick={() => select(null)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-default"
          >
            Live app
            {scenario === null && <Check size={13} />}
          </button>
          {scenarioGroups.map((group) => {
            const isOpen = expanded.has(group.id);
            const isActive = group.id === activeGroup;

            return (
              <div key={group.id}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggle(group.id)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold hover:bg-default"
                >
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="flex-1 truncate">{group.label}</span>
                  {isActive && !isOpen && (
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-orange-500" />
                  )}
                  <span className="text-2xs font-normal text-muted-foreground tabular-nums">
                    {group.items.length}
                  </span>
                </button>
                {isOpen && (
                  <div className="ms-3 border-s border-border ps-1">
                    {group.items.map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={scenario === id}
                        onClick={() => select(id)}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs hover:bg-default"
                      >
                        {label}
                        {scenario === id && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
