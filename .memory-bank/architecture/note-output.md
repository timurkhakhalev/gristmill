# Persisted Note output

`NoteReadService.readOutput` reads either Note scope or an explicit run scope. Notes IPC and preload validate the internal request and response with `noteOutput.ts`. Reads do not select runs, write projections, start processing, repair artifacts or read raw audio.

## Sources and availability

Note scope returns manual content, the saved Summary projection and the shared Note transcript. Recording-to-current-run references describe processing selection; they do not prove the origin of a saved projection. The database does not record that origin, so projection provenance has no run IDs and freshness is `unknown`. Notes without recordings can have a plain imported transcript with no structured segments.

The existing transcript reader owns offsets, coverage and speaker identity. It reports the actual source runs and recording IDs used by the aggregate. Combined runs supply overlapping audio once. A missing or invalid artifact stays unavailable with diagnostics; the reader does not substitute a Note projection for a run artifact.

Run scope checks that the run and all source recordings belong to the requested Note. A Summary-only run reads transcript and corrections from its source run. Its own Summary takes priority; until it exists, the source run can supply Summary. The DTO reports these separate origins. Historical reads leave current selection and Note projections intact. Corrections are current persisted values, not a historical snapshot of names.

`readMeetingRunOutput` supplies the shared artifact policy for the worker and Note reader. The worker retains publication, queue, revision and Tasks/Recap write ownership.

## Freshness

Run Summary freshness compares saved generation metadata with current manual content, participants, run configuration and the authoritative transcript-source correction revision. Renaming the Note does not change Summary freshness or its dismissal revision. That correction revision includes cleared correction tombstones. Known changes produce `stale`; complete matching metadata produces `current`; missing or invalid metadata produces `unknown`. A text fingerprint or current-run pointer does not prove freshness.

The freshness revision in the DTO is a dismissal identity for the Results notice. It does not authorize writes or replace processing revision guards.

## Consumers

The Results panel reads Note scope plus its chosen run. It preserves aggregate transcript semantics across capture groups and labels the Note Summary separately when the run has no Summary. The hook rejects responses after Note/run changes, superseding refreshes or unmount. Initial loading and transport failures remain visible. Refreshes of the same Note and run keep the last loaded output visible, including after a failed refresh. Changing the Note or run clears the old output. Confirmed optimistic speaker corrections can temporarily precede the read response.

Editor drafts remain with the editor. The Summary fallback view and its copy action can contain an unsaved enhancement. Main output always describes persisted data. Preview fixtures remain a renderer-only path.

The `get_note` Chat tool reads Summary/manual text from Note scope and retains its metadata and text preference. Public CLI methods remain in the same read owner: Summary uses the saved projection; transcript and transcript search use the aggregate. Public CLI JSON does not expose internal run provenance. Home and search snippets keep their batched Note-row policy; they do not read artifacts per snippet. Embedded Chat and follow-up keep their draft and prompt-material policies. Transcript export keeps its projection timeline.

See [ADR-0009](../adr/0009-note-output-scopes.md).
