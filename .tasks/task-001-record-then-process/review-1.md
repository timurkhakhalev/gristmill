# PlanAct milestone audit — record then process

Status: blocked

## Reviewed milestone commits

- **M1:** `bd0d603b`, `52714ef9`, `0e0f08fd`, `2ceb4a44`.
- **M2:** `9028b992`, `485b17dd`, `58ef1f5c`, `c49cb910`, `30ce4434`, `1485e2fb`, `b7901205`, `e6d99434`, `beda40d5`, `4f157947`, `0f6331de`, `8e99ea4e`.
- **M3:** `e192dd51`, `7dcf9f86`, `c871bf01`.
- **M4 and integration:** `15717b7a`, `de86d1ce`, `cbc2c026`, `0798ff68`, `bb69d9c7`, `731b8845`, `8534657f`, `f7823d59`, `d9b022b7`, `dbada7c1`, `f2fcc4dd`, `bcdb3332`; final verification recorded in `9920ac41`.

The task-local plan is self-contained. I compared the commits with `main`, read `implementation_progress.md`, and inspected the current implementation and relevant tests. There is no earlier `review-*.md` report for repeated-finding references.

## M1 — Storage and results

**M1 status: fail.** The additive SQLite tables, raw epoch files, result files, recovery reconciliation, deletion intents, and tests match much of the storage scope. The blocked-run configuration correction contract is not reachable from the product.

### M1-1 — high — A blocked initial run cannot have its saved configuration corrected

- **Files:** `src/helpers/database.ts:1303`, `src/helpers/database.ts:1382`, `src/contracts/meetingProcessing.ts:102`, `src/helpers/meetingProcessing.ts:245`, `src/components/notes/MeetingResultsPanel.tsx:142`.
- **Violated requirement:** M1 scope requires an explicit action that corrects a blocked run's configuration with main validation. Its saved route must remain stable across ordinary retry.
- **Evidence:** `updateBlockedMeetingRunConfig` exists only as a database method and in its direct persistence test; no IPC contract, handler, preload method, or Notes control calls it. `retryMeetingProcessingRun` resets status and attempt count but does not change `config_json`. The Notes “new ASR” button calls `makeRun`, which returns immediately when no transcript-backed `selected` result exists. A recording whose initial run is blocked for a missing or unsupported configuration has no such selection.
- **Mechanism and impact:** After the user corrects settings, Retry reuses the invalid snapshot and blocks again. In the common no-transcript case, the visible New ASR action also does nothing. The user cannot recover that saved recording through the specified blocked-run correction flow; later settings changes cannot legitimately alter its pending run.

## M2 — Capture and safe Stop

**M2 status: pass.** The reviewed commit replaces live meeting publication with separate raw capture, bounded acknowledged renderer writes, drain-before-finalize, native tap close, source-health states, and safe quit. The focused Stop suite is reported as 50/50 and the packaged Notes smoke passed. The plan and implementation log explicitly defer live mic/system hardware smoke to Timur, so the no-tail-loss and ≤1-second crash-loss guarantees remain unverified; this is a residual verification note, not a claimed hardware pass.

## M3 — Processing after Stop

**M3 status: fail.** The worker persists runs and raw responses, uses the existing provider adapters, builds a timeline-aligned mono WAV, and separates transcript from summary. A missing summary configuration is incorrectly reported as successful completion.

### M3-1 — high — Missing summary configuration completes the run

- **Files:** `src/helpers/meetingProcessing.ts:513`, `src/helpers/meetingProcessing.ts:523`, `src/helpers/meetingRecordingConfigSnapshot.ts:62`.
- **Violated requirement:** M1 fixed decision says ASR may finish with no summary configuration but summary remains blocked; M3 consumer states require a correctable blocked reason.
- **Evidence:** `snapshotMeetingRecordingConfig` can persist `summary: null`. After a nonempty transcript, `normalize` sets stage `summary` to `complete` when the saved summary is absent; `summarize` has the same completion branch. No summary artifact is written.
- **Mechanism and impact:** A valid transcript with unsupported or absent summary settings appears fully complete. The user loses the blocked indication and ordinary retry is unavailable for a `complete` run, despite the missing generated notes.

## M4 — Notes, retention, verification

**M4 status: fail.** Version selection, scoped corrections, retention/deletion intents, settings, translations, and packaged verification are present. The Notes surface still breaks several required states and audio actions.

### M4-1 — high — Persistent incomplete capture is hidden by processing status

- **Files:** `src/components/notes/MeetingResultsPanel.tsx:245`, `src/components/notes/MeetingResultsPanel.tsx:256`.
- **Violated requirement:** The task-level and M3/M4 state contracts require the incomplete-recording flag to remain visible even after successful ASR or summary.
- **Evidence:** Finalization always creates an initial run. The panel chooses the latest run status whenever a run exists; it uses `captureState === "incomplete"` only when there is no run. If the latest run has no error code, the status line also omits `captureErrorCode` when it is null. A recovered interrupted capture with a successfully processed run therefore displays processing completion without its incomplete flag.
- **Mechanism and impact:** Users can mistake a partial recording for a complete meeting after processing or app restart, despite persisted capture state correctly recording incompleteness.

### M4-2 — high — Original source export is inaccessible without a transcript and playback path

- **Files:** `src/components/notes/MeetingResultsPanel.tsx:75`, `src/components/notes/MeetingResultsPanel.tsx:142`, `src/components/notes/MeetingResultsPanel.tsx:280`, `src/helpers/ipcHandlers.ts:734`.
- **Violated requirement:** M4 requires export of the original mic/system tracks as readable WAV while audio is available, including recordings whose processing is blocked or failed.
- **Evidence:** `selected` is limited to runs with a transcript, and all three audio export buttons render only when `playbackUrl && audioAvailable`. The main export handler can export mic/system directly from finalized epochs without any transcript. A blocked or failed initial run has no transcript, so the UI shows no source export action despite saved raw audio. A playback-path error likewise hides export buttons.
- **Mechanism and impact:** The durable source of truth cannot be obtained from Notes precisely when ASR is unavailable or its mixed playback preparation fails.

### M4-3 — medium — A successful empty transcript has no distinct Notes message

- **Files:** `src/components/notes/MeetingResultsPanel.tsx:319`, `src/locales/en/translation.json:1594`.
- **Violated requirement:** M3 state contract requires a distinct “no speech detected” state for a valid empty transcript.
- **Evidence:** The panel renders segments only when nonempty and renders plain text only when truthy. An artifact with `text: ""` and `segments: []` shows neither; the existing `noSpeechDetected` translation is not used here. The run may show `complete` without telling the user why no transcript text appears.
- **Mechanism and impact:** Users cannot distinguish valid silence from a missing or failed result in the Notes result panel.

### M4-4 — medium — Playback request failures are silent in Notes

- **Files:** `src/components/notes/MeetingResultsPanel.tsx:88`, `src/helpers/ipcHandlers.ts:710`.
- **Violated requirement:** M4 pre-response and error states require a visible playback error.
- **Evidence:** The main handler returns `{ success: false, error }` for unavailable audio, unselected results, and mixer failures. The panel's fulfilled-promise branch handles only `success && path`; it displays an error only if the promise rejects. On a normal failed IPC response, playback controls disappear without an error message.
- **Mechanism and impact:** The user sees neither playable audio nor an explanation or recovery context when playback preparation fails.

## Summary

| Severity | Count |
| --- | ---: |
| critical | 0 |
| high | 4 |
| medium | 2 |
| minor | 0 |

## Verification commands and results

- **Run in this review:** `git diff --check main...HEAD` — passed. `git log --oneline main..HEAD`, `git show --stat` for milestone commits, `rg`, and targeted source/test reads were used for static inspection.
- **Not run in this review:** all tests, builds, installs, native rebuilds, and hardware smoke, per the explicit orchestrator restriction. This includes the M1/M2/M3/M4 focused commands and the plan's `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run pack`, and `node scripts/smoke-electron.js` sequence.
- **Recorded root verification:** `pnpm run typecheck` passed; `pnpm run lint` passed with 0 errors and 36 warnings; focused M4 32/32, M2 Stop 50/50, locale 8/8, main-build 7/7; full `pnpm test` 2768/2768; `pnpm run pack` and `node scripts/smoke-electron.js` passed. These are reported evidence in `plan.md`/`implementation_progress.md`, not independent reruns by this reviewer.

## Residual notes

- Live mic/system recording, Stop tail comparison, device restart, process-kill loss measurement, and real post-Stop voice recognition remain unverified in this review. The user explicitly deferred hardware smoke; automated and packaged results do not establish the ≤1-second capture-loss guarantee.
- No unrelated test failure was observed because tests were not run here. The worktree's pre-existing untracked `node_modules` entry was left untouched.
