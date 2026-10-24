import { useEffect, useState } from "react";
import type { NoteOutput } from "../contracts/noteOutput";
import { runInBackground } from "../stores/noteStore";

type NoteScopeOutput = Extract<NoteOutput, { scope: "note" }>;

type RunScopeOutput = Extract<NoteOutput, { scope: "run" }>;

/** Persisted output only. Editor drafts stay with the editor's write owner. */
export function useNoteOutput(
  noteId: number,
  runId: string,
  enabled: boolean,
  correctionRevision = 0
) {
  const [state, setState] = useState<{
    noteId: number;
    runId: string;
    note: NoteScopeOutput | null;
    run: RunScopeOutput | null;
    loading: boolean;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let revision = 0;

    const refresh = async () => {
      const expected = ++revision;
      // Refresh the same output in place so metadata edits do not blank the Summary.
      setState((previous) =>
        previous?.noteId === noteId && previous.runId === runId && previous.note
          ? { ...previous, loading: false, error: null }
          : { noteId, runId, note: null, run: null, loading: true, error: null }
      );

      try {
        const [note, run] = await Promise.all([
          window.electronAPI.getNoteOutput({ noteId, scope: "note" }),
          runId
            ? window.electronAPI.getNoteOutput({ noteId, scope: "run", runId })
            : Promise.resolve(null),
        ]);

        if (!active || expected !== revision) return;

        if (
          note.scope !== "note" ||
          note.noteId !== noteId ||
          (run && (run.scope !== "run" || run.runId !== runId || run.noteId !== noteId))
        )
          throw new Error("Unexpected Note output identity");
        setState({
          noteId,
          runId,
          note,
          run,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (active && expected === revision)
          setState((previous) =>
            previous?.noteId === noteId && previous.runId === runId && previous.note
              ? { ...previous, loading: false, error: String(error) }
              : { noteId, runId, note: null, run: null, loading: false, error: String(error) }
          );
      }
    };

    runInBackground(refresh(), "Note output refresh failed");
    const processing = window.electronAPI.onMeetingProcessingUpdated(() => void refresh());

    const notes = window.electronAPI.onNoteUpdated((note) => {
      if (note.id === noteId) runInBackground(refresh(), "Note output refresh failed");
    });

    return () => {
      active = false;
      processing();
      notes();
    };
  }, [noteId, runId, enabled, correctionRevision]);

  if (!enabled || state?.noteId !== noteId || state.runId !== runId)
    return { note: null, run: null, loading: enabled, error: null };

  return state;
}
