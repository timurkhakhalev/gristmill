# PlanAct milestone audit — record then process, after M6

Status: blocked

## Reviewed milestone commits

- **M1:** `bd0d603b`, `52714ef9`, `0e0f08fd`, `2ceb4a44`.
- **M2:** `9028b992`, `485b17dd`, `58ef1f5c`, `c49cb910`, `30ce4434`, `1485e2fb`, `b7901205`, `e6d99434`, `beda40d5`, `4f157947`, `0f6331de`, `8e99ea4e`.
- **M3:** `e192dd51`, `7dcf9f86`, `c871bf01`.
- **M4 and integration:** `15717b7a`, `de86d1ce`, `cbc2c026`, `0798ff68`, `bb69d9c7`, `731b8845`, `8534657f`, `f7823d59`, `d9b022b7`, `dbada7c1`, `f2fcc4dd`, `bcdb3332`; verification recorded in `9920ac41`.
- **M5:** `9b4755a6`, `79bdbd77`, `0fbe743f`, `0d2041c1`, `98ef791c`, `fdc7fdbf`; verification recorded in `f463a8bf`.
- **M6:** `d0795810`, `baff7416`; verification recorded in `f7f188e3`.

I read `plan.md`, `implementation_progress.md`, `review-1.md`, and `review-2.md`, then inspected the current M1–M6 code, milestone diffs, and focused regression tests. The M5/M6 links to committed task-local review reports are the permitted diagnostic-contract exception; the plan remains self-contained.

## M1 — Storage and results

**M1 status: fail.** SQLite storage, artifacts, recovery, deletion intents, and immutable run history remain intact. The initial blocked-run correction path works. The fixed decision that later global settings must not prevent correction of a saved run is still unmet in the summary-only path described in M6-1.

## M2 — Capture and safe Stop

**M2 status: pass.** M6 does not change the mic/system raw writers, bounded capture queues, Stop drain, or quit flow. The recorded focused Stop suite remains 50/50. Live mic/system capture and crash-loss measurements remain deferred by the user and unverified.

## M3 — Processing after Stop

**M3 status: pass.** The worker still persists raw provider responses before normalization, keeps transcript and summary artifacts separate, and can resume a summary from saved transcript without a new ASR request when it receives valid corrected configuration. The absent-summary state remains blocked, resolving `review-1.md` **M3-1**.

## M4 — Notes, retention, and verification

**M4 status: fail.** Audio deletion without a transcript now opens confirmation and supports cancel/error/retry. Recording selection makes a newer transcriptless recording visible and scopes actions to it, resolving the direct cases in `review-2.md` **M4-1** and **M5-2**. Switching to a recording with an older transcript and a newer pending run can still change its persisted current-run selection and Notes projection, as described in M6-2.

## M5 — Reviewer Fix 1

**M5 status: pass for its original six findings.** The current code shows incomplete capture with processing status, exports source WAV without playback/transcript, renders a no-speech state, reports playback errors, corrects a blocked pre-ASR run, and keeps absent summary configuration blocked. M6 adds the post-ASR summary correction path sought by `review-2.md` **M5-1**, but its Notes action has the settings dependency in M6-1.

## M6 — Reviewer Fix 2

**M6 status: fail.** The reviewed commit adds the missing deletion flow, a summary-only main update that preserves the ASR route, and a separate recording selector. Two state-dependent cases remain outside the added focused tests.

### M6-1 — high — Summary-only correction fails when current transcription settings are unsupported

- **Files:** `src/components/notes/MeetingResultsPanel.tsx:245`, `src/helpers/meetingRecordingConfigSnapshot.ts:22`, `src/components/settings/MeetingSettings.tsx:58`, `src/helpers/database.ts:1398`, `test/components/meetingResultsPanel.test.js:362`.
- **Violated requirement:** M1 fixed decision says global settings changes must not alter or strand a saved run. M6 acceptance requires correction of a missing summary configuration on the blocked run without changing its saved ASR route or calling ASR again.
- **Evidence:** The Notes action obtains the new summary through `snapshotMeetingRecordingConfig()`, which returns `{ config: null, configError: unsupported-transcription-route }` before reading note-formatting settings whenever the *current* meeting transcription mode is `self-hosted`. That mode is selectable in Meeting Settings. The action then sends the saved transcription with `summary: null` and the non-null transcription error; main rejects summary-only correction because it requires a non-null new summary and null error. The M6 UI test changes the current transcription language but keeps it on a supported route, so it does not cover this case.
- **Mechanism and impact:** If a user recorded with a supported ASR route, later selects Self-Hosted meeting transcription for other work, and fixes the summary settings, the already saved transcript remains blocked for summary even though its ASR route is persisted and no longer needed. Ordinary Retry preserves the missing summary snapshot and blocks again. This is the same post-ASR correction gap in a narrower state after M6.
- **Prior finding:** `review-2.md` **M5-1**, itself related to `review-1.md` **M1-1**. M6 resolves the supported-current-route case but not this one.

### M6-2 — high — Switching recordings can replace a pending current run with an older transcript

- **Files:** `src/components/notes/MeetingResultsPanel.tsx:29`, `src/components/notes/MeetingResultsPanel.tsx:157`, `src/components/notes/MeetingResultsPanel.tsx:170`, `src/helpers/database.ts:1256`, `src/helpers/database.ts:1499`, `src/helpers/meetingProcessing.ts:679`, `test/components/meetingResultsPanel.test.js:304`.
- **Violated requirement:** M1 stores the selected/current run, M3 publishes the active run's result when it completes, and M4 keeps all versions and the Notes projection coherent. M6 must preserve those guarantees while adding recording selection.
- **Evidence:** Creating a new run sets `meeting_recordings.current_run_id` to that new run. When the user switches to a recording with an older transcript but a newer run still pending or blocked without a transcript, `selectRecording` chooses `latestTranscript` and calls `selectRun`. That IPC action projects the older transcript to the Note and updates `current_run_id` to the older run. `publishCurrentSelection` later ignores the newer run because its ID no longer matches `currentRunId`. M6's two-recording test gives each recording only one run and therefore does not exercise this state.
- **Mechanism and impact:** Merely viewing that recording changes durable selection and Notes content. The newer run can finish successfully but its transcript and summary will not automatically become the Note's selected projection. The run history survives, but active state and the expected result publication are lost until the user selects the newer result manually.
- **Prior context:** This is a new overcorrection in the selector added for `review-2.md` **M5-2**; that report's original hidden-recording case is resolved.

## Summary

| Severity | Count |
| --- | ---: |
| critical | 0 |
| high | 2 |
| medium | 0 |
| minor | 0 |

## Verification commands and results

- **Run in this review:** `git diff --check main...HEAD` and `git diff --check` — passed. `git log`, `git show`, `rg`, and targeted source/test reads supplied static evidence.
- **Not run in this review:** focused tests, full tests, builds, dependency installation, native rebuilds, and hardware smoke, per the orchestrator restriction. The planned M1–M6 commands were therefore not independently rerun here.
- **Recorded root verification:** M6 focused suite 42/42; `pnpm run typecheck` passed; `pnpm run lint` passed with 0 errors and 36 warnings; `pnpm run i18n:check` passed; sequential `pnpm test` passed 2783/2783; `pnpm run pack` and `node scripts/smoke-electron.js` passed. These are results reported in `plan.md` and `implementation_progress.md`, not tests run by this reviewer. Earlier milestone results, including M2 Stop 50/50, remain recorded there.

## Residual notes

- The user deferred isolated live mic/system recording, Stop tail comparison, device restart, process-kill loss measurement, and real voice-recognition smoke. These guarantees are not verified by the automated or packaged results.
- No unrelated test failure was observed because tests were not run here. The pre-existing untracked `node_modules` entry and concurrently modified `plan.md` were left untouched.
