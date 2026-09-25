# PlanAct milestone audit — record then process, after M5

Status: blocked

## Reviewed milestone commits

- **M1:** `bd0d603b`, `52714ef9`, `0e0f08fd`, `2ceb4a44`.
- **M2:** `9028b992`, `485b17dd`, `58ef1f5c`, `c49cb910`, `30ce4434`, `1485e2fb`, `b7901205`, `e6d99434`, `beda40d5`, `4f157947`, `0f6331de`, `8e99ea4e`.
- **M3:** `e192dd51`, `7dcf9f86`, `c871bf01`.
- **M4 and integration:** `15717b7a`, `de86d1ce`, `cbc2c026`, `0798ff68`, `bb69d9c7`, `731b8845`, `8534657f`, `f7823d59`, `d9b022b7`, `dbada7c1`, `f2fcc4dd`, `bcdb3332`; verification recorded in `9920ac41`.
- **M5:** `9b4755a6`, `79bdbd77`, `0fbe743f`, `0d2041c1`, `98ef791c`, `fdc7fdbf`; verification recorded in `f463a8bf`.

I read `plan.md`, `implementation_progress.md`, and `review-1.md`, then inspected the current code, M5 diffs, and regression tests. The M5 plan's reference to its committed task-local review report is the allowed diagnostic-contract exception; the plan remains self-contained.

## M1 — Storage and results

**M1 status: fail.** The original storage, recovery, artifact, and deletion contracts remain in place. M5 now exposes main-validated correction for an initial blocked run before any artifact exists, resolving the no-transcript case from `review-1.md` finding **M1-1**. The same fixed decision remains unmet once a transcript exists and summary configuration is missing, as detailed in M5-1.

## M2 — Capture and safe Stop

**M2 status: pass.** M5 does not change the mic/system writers, drain barrier, native tap close, or safe Stop. The recorded focused Stop result remains 50/50. Live mic/system hardware smoke and its ≤1-second crash-loss measurement remain explicitly deferred and unverified.

## M3 — Processing after Stop

**M3 status: pass.** M5 changes a nonempty transcript with no summary config from `complete` to `blocked`, retaining its saved transcript and raw response. The prior `review-1.md` finding **M3-1** no longer reproduces as a status error. The blocked run's correction path is still restricted by M5-1 below.

## M4 — Notes, retention, and verification

**M4 status: fail.** In single-recording cases, the panel now keeps incomplete capture visible, exposes original-track export without playback or transcript, shows no-speech text, and reports failed playback responses. These address `review-1.md` findings **M4-1** through **M4-4** for the cases the new mounted tests cover. Multiple recordings in one Note and a no-transcript audio deletion remain broken.

### M4-1 — high — A saved recording without a transcript cannot be deleted through its visible Audio action

- **Files:** `src/components/notes/MeetingResultsPanel.tsx:73`, `src/components/notes/MeetingResultsPanel.tsx:242`, `src/components/notes/MeetingResultsPanel.tsx:292`.
- **Violated requirement:** M4 requires a working confirmed audio-only deletion flow, including pending/blocked processing results; success or failure must reflect the actual deletion operation.
- **Evidence:** `selected` is null when the Note has no transcript-backed run. The panel still renders Delete Audio when `audioAvailable` is true, but `confirmDeleteAudio` immediately returns if `selected` is null. The Retry Delete action has the same handler. The M5 mounted tests cover export and New ASR for this no-transcript state, not deletion.
- **Mechanism and impact:** A saved recording whose initial run is blocked or failed before normalization shows a deletion action that opens no confirmation and sends no deletion request. Its raw audio cannot be explicitly removed through Notes even though the main deletion endpoint supports it.

## M5 — Reviewer Fix 1

**M5 status: fail.** M5 resolves the directly tested single-recording reproducers and adds focused tests, but its restrictions and result selection leave two task-level guarantees unmet.

### M5-1 — high — Missing summary configuration cannot be corrected on the blocked run

- **Files:** `src/helpers/meetingProcessing.ts:260`, `src/helpers/database.ts:1382`, `src/components/notes/MeetingResultsPanel.tsx:289`, `src/helpers/database.ts:1303`.
- **Violated requirement:** M1 fixed decision requires an explicit main-validated correction on a blocked run. M5 acceptance requires a nonempty saved transcript with absent summary config to remain blocked and correctable while ordinary retry preserves its snapshot.
- **Evidence:** M5 correctly sets `missing-summary-config` after transcript persistence. Its update action rejects every run with a raw response or transcript, and the Notes button appears only without those artifacts. The database update also requires `raw_response_path`, `transcript_path`, and `summary_path` all null. Ordinary retry preserves the null summary snapshot, so the run blocks again. The new tests separately cover the blocked state and correction of a run with no artifacts; none covers correction after ASR.
- **Mechanism and impact:** A user who fixes summary settings after ASR cannot resume the same blocked run's summary. Creating a separate summary run leaves the original run blocked and does not satisfy the specified blocked-run correction contract. The route immutability guarantee is relevant to saved ASR data, but this restriction also prevents correction of summary-only configuration.
- **Prior finding:** `review-1.md` **M1-1** persists for the post-ASR blocked configuration case; its original no-transcript case is resolved.

### M5-2 — high — A newer transcriptless recording is hidden behind an older result

- **Files:** `src/helpers/database.ts:996`, `src/components/notes/MeetingResultsPanel.tsx:37`, `src/components/notes/MeetingResultsPanel.tsx:73`, `src/components/notes/MeetingResultsPanel.tsx:127`, `src/components/notes/MeetingResultsPanel.tsx:297`.
- **Violated requirement:** M4 requires all recording/result states in a Note to remain accessible, incomplete capture to remain visible, and original source export to work for saved audio without a transcript. M5 specifically claims the latter two findings are closed.
- **Evidence:** A Note may have multiple recording rows, returned oldest first. The panel selects only transcript-backed runs; if recording A has a transcript and later recording B is blocked before normalization, selection falls back to A. `currentRecording` becomes A, and every status/action uses A. The version picker lists only transcript-backed runs, so B cannot be selected. M5 mounted tests supply exactly one recording per test.
- **Mechanism and impact:** B's incomplete/blocked status is invisible, and Source Export, New ASR, Update Run Settings, and Delete Audio target A rather than B. The original `review-1.md` **M4-1** and **M4-2** failures therefore still reproduce for a newer recording in a Note with older results.
- **Prior findings:** `review-1.md` **M4-1** and **M4-2** persist in the multiple-recording case; their single-recording cases are resolved.

## Summary

| Severity | Count |
| --- | ---: |
| critical | 0 |
| high | 3 |
| medium | 0 |
| minor | 0 |

## Verification commands and results

- **Run in this review:** `git diff --check main...HEAD` and `git diff --check` — passed. I also used `git log --oneline`, `git show`, `git diff`, `rg`, and targeted source/test reads for static inspection.
- **Not run in this review:** tests, builds, dependency installation, native rebuilds, and hardware smoke, per the explicit orchestrator restriction. This includes the plan's M1–M5 focused commands and the full integration command sequence.
- **Recorded root evidence:** M5 focused tests 38/38; `pnpm run typecheck` passed; `pnpm run lint` passed with 0 errors and 36 warnings; `pnpm run i18n:check` passed; sequential `pnpm test` passed 2779/2779; `pnpm run pack` and `node scripts/smoke-electron.js` passed. These results are reported in `plan.md` and `implementation_progress.md`, not independently rerun here. Earlier M1–M4 verification, including M2 Stop 50/50 and M4 32/32, remains recorded there.

## Residual notes

- The user deferred live isolated mic/system recording, tail comparison, device restart, process kill, and real voice recognition. None is counted as verified by the automated or packaged results.
- No unrelated test failure was observed because tests were not run here. The pre-existing untracked `node_modules` entry and concurrently modified `plan.md` were left untouched.
