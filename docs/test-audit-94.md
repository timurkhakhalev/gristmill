# Test audit implementation: issue #94

The starting snapshot was `fa4374c2cb082591e6e086a94f7b28a23be389a6`:
413 registered files, 2881 passing cases. Issue #95 established the two-process
runner and its measured baseline before this test-content cleanup. Issue #93 is
outside this change.

## Removed cases and surviving coverage

| Removed test or case | Surviving behavior or retired path |
| --- | --- |
| `localFileTranscriptionBehavior` | Real `localFileTranscriptionIpc` covers provider dispatch, language, missing request ID and cancellation through the application registry. The preload contract remains in `localFileTranscriptionBridge`. |
| `notificationInteractivity` | Real `windowManagerMeetingNotification` exercises owner, hover and countdown behavior. Non-macOS window behavior is outside the supported product. |
| `segmentSpeakerName` handwritten grouping case | `meetingTranscriptChat` renders the A,A,B,B,A,A reassignment through the actual component. Resolver cases remain. |
| `openaiRealtimeStreaming` handwritten reconnect guard | Meeting capture no longer establishes a realtime provider connection; `meetingStreamingWiring` and `meetingCoordinatorIpc` protect raw capture without model credentials. Protocol, stop and finalization tests remain in `openaiRealtimeStreaming`. |
| `settingsStoreUploadTranscription` | Unique Groq and streaming-only selection cases moved to the pure `settingsSelectors` suite. |
| `meetingRecordingStoreImports` | Initial empty state moved to `meetingRecordingStoreAutoEndStop`; its store import is exercised by behavior suites. The unused segment reducer was removed. |
| `rendererEntryTypeProbe` | Strict `pnpm run typecheck:renderer` covers every renderer TS/TSX source and is required with full suite runs. |
| Three repeated composition-root cases in actions/calendar bridges | `chatBridge` runs one real shared `setupHandlers` registration and checks all migrated channel families; each bridge keeps its own emitted-preload validation cases. |
| Snippet expansion and range cases | Those dictation helpers had no production callers. `getDictionaryHintWords`, snippet CRUD, tools and UI remain. |
| Stale onboarding field-direction entries | `fieldDirectionPolicy` inventories active native fields; the unused `UseCaseStep` and `ShortcutSetupStep` references were removed. |

The following 20 test files and their unused production implementations were
removed together after checking imports, exports, registries and dynamic paths:

| Retired test | Unused implementation |
| --- | --- |
| `controlPanelWindowMode` | `controlPanelWindowMode.ts` |
| `localDownloadState` | `localDownloadState.ts` and `BackgroundModelDownloadTray.tsx` |
| `macAccessibilityReadiness` | `macAccessibilityReadiness.ts` |
| `onboardingHotkeyPresentation` | `hotkeyPresentation.ts` and the unused `ShortcutSetupStep.tsx` |
| `onboardingUseCases` | `useCases.ts` and the unused `UseCaseStep.tsx` |
| `setupEligibility` | `setupEligibility.ts` |
| `shortcutSetupStep` | `ShortcutSetupStep.tsx` |
| `treeRowActionClearance` | Only `treeRowActionClearanceStyle` in active `treeDirection.ts` |
| `activationModeSelector` | `ActivationModeSelector.tsx` |
| `authAccountScope` | `authAccountScope.ts`; the M1 source-presence assertion was updated |
| `reactiveLocalFlag` | `reactiveLocalFlag.ts` |
| `noteListQuery` | `noteListQuery.ts` |
| `meetingSegmentReducer` | `meetingSegmentReducer.ts` |
| `agentSelectionContext` | `agentSelectionContext.ts` |
| `dateGrouping` | `dateGrouping.ts` |
| `formatAmount` | `formatAmount.ts` |
| `latestValueScheduler` | `latestValueScheduler.ts` |
| `liveTranscriptPresentation` | `liveTranscriptPresentation.ts` |
| `managedAzureTranscriptionUrl` | Only `buildManagedAzureTranscriptionUrl` in active `urlUtils.ts` |
| `validation` | `validation.ts` |

## Strengthened and cheaper checks

- Removed tautological actions and provider URL assertions; pinned explicit
  normalization results. Container validation checks the exact error and zero
  DB calls. Offline asset tests use synthetic assets and observe no network
  access. Vocabulary tests use separate registrations and storage. Download
  cancellation holds both IDs pending; proxy redirect tests reject a private
  target. The VAD cache case seeds its own cache and checks zero downloads.
- Corrected the installed llama.cpp result and a mic/system timestamp race in
  production together with their characterization tests.
- Removed SQLite setup from two bridge fixtures, a 26 MiB file allocation from
  remote-transcription validation, and two real one-second waits from chat
  persistence tests. UI shortcut checks now assert label-to-chord pairs; note
  output checks assert the model result was actually persisted.
- Restored changed globals/module loaders and removed owned temporary
  directories in touched fixtures. The registry still explicitly owns domain
  and kind selection.
- The SpacesTree SSR test now checks that each note title and dropdown trigger
  are separate flex children in both directions. Transcript SSR tests check
  windowing and that only the newest settled row animates. SSR does not prove
  pixel clearance or scroll/remount behavior; those remain UI smoke concerns.

Negative control: temporarily changed the `/v1/models` normalization in
`src/config/constants.mts` to return `/BROKEN`, ran
`pnpm test -- test/helpers/providerUrlPolicyParity.test.js`, and observed
exit 1 with the normalization case failing (2 pass, 1 fail). The original
source bytes were restored immediately.

## Verification and new baseline

The first integrated full run found two stale references in
`fieldDirectionPolicy` (2583/2585 ordinary cases and 163/163 serial cases,
0 skip/cancel). It took 450.22 s, peaked at 1356 MiB process-tree RSS and
235% tree CPU, with no swap growth. The references were removed and the
four affected cases passed focused.

| Final check | Result |
| --- | --- |
| `pnpm run lint` | Exit 0; no errors. Existing warnings remain outside changed code. |
| `pnpm run typecheck` | Exit 0, including strict renderer and settings selectors. |
| `pnpm test -- --processes 2` | 388 files, 2586 + 163 = 2749 pass, 0 fail/skip/cancel. |
| `git diff --check` | Exit 0. |

The final full run took **476.06 s** including SQLite preparation and one
main build. Peak descendant-tree RSS was **1286 MiB**, peak tree CPU **232%**;
swap stayed at **5421 MiB** (0 MiB growth). System-wide free memory was 61%
after the run, and `pmset -g therm` reported no thermal or performance warning.
The runner lock was removed and no owned test process remained. This is the
new baseline for #93; the 413-file #95 measurement is a different workload.

Automated tests do not establish live microphone/system-audio or real provider
behavior.
