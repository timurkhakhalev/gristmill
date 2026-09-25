# Full-change code review — record then process

Status: findings remain. Reviewed the complete `main...HEAD` change and M1–M7 commit set against `plan.md`, `implementation_progress.md`, and `review-1.md` through `review-4.md`. This is a static review; the previously reported root checks were not rerun here.

## Findings

### CR-1 — medium — An older visible transcript cannot be played while a newer run is pending

- **Files:** `src/helpers/ipcHandlers.ts:718-720`, `src/components/notes/MeetingResultsPanel.tsx:68-75`, `src/components/notes/MeetingResultsPanel.tsx:102-107`, `src/components/notes/MeetingResultsPanel.tsx:161-169`.
- **Trigger and violated behavior:** A recording has an older saved transcript and a newer pending run. The newer run becomes `currentRunId`, while Notes deliberately displays the older transcript until the new one is saved. M4 requires playback/seek of the displayed result, and M7 requires this pending-result view without changing durable selection.
- **Evidence and impact:** The panel calls `meetingRecordingGetPlaybackPath` with the older displayed run ID. Main rejects it unless `recording.currentRunId === run.id`, returning `meeting-result-not-selected`. Notes then shows a playback error, no audio player or seek controls, and no mixed-export button, although the old transcript and original audio are present. The M7 mounted test covers this exact displayed-old/pending-new state (`test/components/meetingResultsPanel.test.js:363-394`) but stubs playback without checking its request or result. Allow playback of any transcript-backed run belonging to the recording without changing its persisted selection.

### CR-2 — medium — Exporting a long source track can stall or exhaust the main process

- **Files:** `src/helpers/meetingAudioExport.ts:28-43`, `src/helpers/meetingRecordingStorage.ts:216-225`, `src/helpers/ipcHandlers.ts:750-757`.
- **Trigger and violated behavior:** Export mic or system WAV for a long recording, particularly one stored as a single epoch (the planned normal case, with no minute rotation). M4 requires usable export of original tracks.
- **Evidence and impact:** The IPC handler calls synchronous export on Electron's main thread. For each epoch, `readEpochSamples` loads the entire PCM file with `fs.readFileSync`, then export writes it synchronously. At 24 kHz, 16-bit mono, one hour is about 173 MB per source; several hours require hundreds of MB to gigabytes in one Buffer and block the app during I/O. At sufficient length, allocation failure prevents export. Copy epoch data in bounded chunks while preserving timeline offsets and atomic publication.

## Counts and readiness

| Severity | Count |
| --- | ---: |
| critical | 0 |
| high | 0 |
| medium | 2 |
| minor | 0 |

The two findings warrant correction before merge. I found no additional actionable issue in the inspected capture, persistence, processing, deletion, and Notes paths; that is not proof of correctness for every branch in this 117-file diff. The prior milestone review reported zero findings after M7; CR-1 spans its UI selection and main playback contracts, and CR-2 concerns long-duration export behavior.

## Verification and gaps

- **This review:** Static reads of the task plan, progress log, prior reviews, changed code, and relevant tests; `git diff --check main...HEAD` and `git diff --check` passed. No files other than this report were edited.
- **Root-reported automated evidence:** M7 focused 31/31; full 2785/2785; typecheck passed; lint passed with 0 errors and 36 warnings; i18n check, pack, and packaged Electron smoke passed. These checks were not independently rerun in this review.
- **Still unverified:** Timur deferred live mic/system hardware recording, Stop-tail comparison, device restart, process-kill loss measurement, and real post-Stop recognition. Automated and packaged checks do not establish the hardware capture-loss guarantee.
