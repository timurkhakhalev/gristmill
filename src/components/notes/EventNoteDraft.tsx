import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "../icons";
import { RichTextEditor } from "../ui/RichTextEditor";
import NoteBottomBar from "./NoteBottomBar";
import NoteParticipants from "./NoteParticipants";
import NoteRecordControl from "./NoteRecordControl";
import { setNoteHandoff } from "./noteHandoff";
import type { EventDraftHandoff } from "../../lib/noteEditorPendingSave";
import type { CalendarEvent } from "../../contracts/calendar";
import type { NoteItem } from "../../contracts/notes";
import { parseAttendees } from "../../utils/calendarAttendees";
import { formatDate, parseEventDate } from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";
import { useUiLocale } from "../../hooks/useUiLocale";
import logger from "../../utils/logger";

export type EventDraftIntent = "write" | "record" | "ask";

interface EventNoteDraftProps {
  event: CalendarEvent;
  onBack: () => void;
  /** The note now exists; open it, and start recording when that was the intent. */
  onMaterialized: (note: NoteItem, intent: EventDraftIntent) => void;
  /** Receives the full latest draft for the note's owner to persist. */
  onDraftHandoff: (handoff: EventDraftHandoff) => void;
}

/**
 * A calendar event opened before it has a note: it looks like the note editor
 * but stores nothing. The note is created only when the user writes, starts
 * recording or asks the chat, and that first input goes into it.
 *
 * The draft never persists the note itself beyond the create call: every typed
 * revision is handed to the note owner (the editor's pending-save pipeline),
 * read at handoff time after all awaits, so keystrokes that land during the
 * create/update round-trips are never lost — and input never has to be
 * disabled while the request runs.
 */
export default function EventNoteDraft({ event, onBack, onMaterialized, onDraftHandoff }: EventNoteDraftProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const { dateFormat } = useDateTimePreferences();
  const participants = useMemo(() => parseAttendees(event), [event]);
  const startDate = parseEventDate(event.start_time);
  const dateLabel = startDate ? formatDate(startDate, locale, { month: "short", day: "numeric" }, dateFormat) : undefined;
  const eventTitle = event.summary || t("upcoming.untitledEvent");
  const titleRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<{ title?: string; content?: string }>({});
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);

  const materialize = useCallback(
    async (intent: EventDraftIntent, handoff: { focus?: "title" | "content"; ask?: string }) => {
      if (creatingRef.current) return;
      creatingRef.current = true;
      setCreating(true);
      try {
        const target = await window.electronAPI.createCalendarEventNote?.(
          event.id,
          { ...draftRef.current }
        );
        if (!target) throw new Error("Calendar event note was not created");
        const note = await window.electronAPI.getNote(target.noteId);
        if (!note) throw new Error("Calendar event note could not be loaded");
        // Read after every await: keystrokes that landed during the whole
        // create → get round-trip are part of the handed-off draft. A reused
        // note keeps its manual content — the typed text appends; a fresh
        // note replaces (its insert already carries the early snapshot).
        onDraftHandoff({
          noteId: target.noteId,
          note,
          mode: target.existing ? "append" : "replace",
          draft: { ...draftRef.current },
        });
        setNoteHandoff({ noteId: note.id, ...handoff });
        onMaterialized(note, intent);
      } catch (error) {
        logger.warn("Failed to create calendar event note", { error: (error as Error).message }, "notes");
        creatingRef.current = false;
        setCreating(false);
      }
    },
    [event.id, onMaterialized, onDraftHandoff]
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="@container mx-auto w-full max-w-[880px] px-[clamp(20px,5vw,54px)] pt-5 max-[720px]:px-5">
        <button
          type="button"
          className="mb-6 inline-flex items-center gap-2 rounded text-xs text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          onClick={onBack}
          aria-label={t("controlPanel.backToNotes")}
        >
          <ArrowLeft size={16} />
          {t("controlPanel.backToNotes")}
        </button>
        <div
          dir="auto"
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          onInput={() => {
            draftRef.current.title = titleRef.current?.textContent ?? "";
            void materialize("write", { focus: "title" });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          role="textbox"
          aria-label={t("notes.editor.noteTitle")}
          className="bg-transparent text-3xl font-semibold leading-tight tracking-tight text-foreground outline-none @max-[520px]:text-2xl"
        >
          {eventTitle}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <NoteParticipants
            noteId={0}
            participants={participants}
            event={event}
            dateLabel={dateLabel}
            preview
          />
          {/* Record shares the date chip's row, pinned to the right edge. */}
          <div className="ms-auto flex items-center gap-1.5">
            <NoteRecordControl
              isRecording={false}
              isProcessing={false}
              disabled={creating}
              capturePhase="idle"
              captureStartedAt={null}
              onStart={() => void materialize("record", {})}
              onStop={() => {}}
            />
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-[clamp(20px,5vw,54px)] pt-4 pb-28 max-[720px]:px-5">
          <RichTextEditor
            value=""
            onChange={(value) => {
              draftRef.current.content = value;
              void materialize("write", { focus: "content" });
            }}
            placeholder={t("notes.editor.startWriting")}
          />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0">
        <NoteBottomBar
          isRecording={false}
          askDisabled={creating}
          onAskSubmit={(text) => void materialize("ask", { ask: text })}
        />
      </div>
    </div>
  );
}
