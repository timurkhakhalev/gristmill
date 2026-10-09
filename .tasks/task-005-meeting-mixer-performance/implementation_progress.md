# Implementation progress

## M1 — Native continuous audio preparation

Status: done

Implemented the private native float timeline helper, authoritative alignment provenance,
fixed-anchor mapper and pinned FFmpeg shared-library build/cache/package inputs.
Application consumer cutover and child lifecycle remain assigned to M2.

Contract sync: M1 has no dependency milestone. Accepted ranges remain the alignment
authority; numeric selection, historical anchors, original files and consumer lifetimes
remain unchanged. Historical ranges receive no invented confidence. Eligible calibrated
ranges carry their stable original segment index, generation and source interval, with
`max(endpoint uncertainty) + 1` as the conservative rounded-coordinate bound.

Joins use the fixed next anchor, the preceding bound, contiguous source coverage and
an effective rate in 0.999–1.001. Rejections preserve mapped gaps and overlap summation.
Epoch boundaries always reset. No same-generation physical micro-gap detection is
claimed. Actual join decisions retain their original preceding end and next anchor for
private M3 reporting. Empty input fails unless intentional silence is explicit.

The C boundary validates the whole mapping and exact decoded length before output
creation, then processes fixed 4096-input/16384-output blocks. Five numeric fields per
bounded mapping line are strict; no prototype duration/range-count caps remain. Success
requires closed output and exact extent. Run-end fill/trim is limited to two samples;
nonterminal output overrun fails. Exit categories are 2 mapping, 3 decoded corruption or
length mismatch, 4 I/O (including errno for ENOSPC), and 5 resampler failure.

Build inputs pin the measured upstream FFmpeg 8.1.1 archive SHA-256:
`b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3`.
The helper uses shared LGPL-2.1-or-later libswresample 6.3.101/libavutil 60.26.101,
with GPL/nonfree/version3/network/OpenSSL disabled. The verified archive/output cache
is gitignored outside package resources. Package inputs include the exact archive,
license/notice, generated full build instructions, compiler/configure manifest and
helper source/build recipe. Existing resource signing discovers the new Mach-O files;
development packaging inherits the added resource filters. AfterPack rejects missing
binaries or source/license materials. Existing Swift deployment targets are unchanged.

Verification (serialized; all final checks pass):

- `pnpm run compile:native`: real native build passed; helper C compiled with
  `-Wall -Wextra -Werror`. All three new binaries are arm64, with `LC_BUILD_VERSION`
  minos 12.0 and SDK 15.5. `otool -L` shows only sibling `@loader_path` libraries and
  system libraries/frameworks, with no Homebrew/cache runtime dependency.
- `pnpm test --verbose test/cases/recording/unit/meetingResamplerMapping.test.ts test/cases/recording/native/meetingResampler.test.ts test/cases/recording/integration/meetingAlignmentPersistence.test.ts test/cases/recording/unit/meetingAudioAlignmentPerformance.test.ts`:
  40 passed, 0 failed, 0 skipped (19 unit/integration and 21 real native checks);
  canonical runner wall time 3.237 s. Coverage includes rate changes/edges, +/-50 and
  +/-1 jitter, confidence/rate rejection, successive corrections, clipped asymmetric
  bounds, actual epoch/generation boundaries including a two-frame gap, independent
  overlap sums and stereo identity, more than 4096 rows, ranges longer than 60 seconds,
  8001-second input, malformed/empty/overflow mapping, exact/truncated/extra decoded
  length, nonfinite audio and I/O failures. Marker error measured at most 0.5 frame
  (0.02084 ms; required <=4 ms), and accepted tone boundary step at most
  0.011521386 (required <0.02). Run-end rounding stays <=2 samples in all fixtures.
- `pnpm test --verbose test/cases/platform/integration/meetingResamplerBuildCache.test.ts`:
  12 passed, 0 failed, 0 skipped; canonical runner wall time 0.559 s. Isolated source/
  compiler-build seams cover unchanged-key reuse, checksum/flags/compiler/architecture/
  deployment-target invalidation (plus helper/recipe/flags), corrupt inputs/outputs,
  complete-cache offline reuse and clear missing-input offline failure without a
  published cache entry.
- Second real `pnpm run compile:native`: reported verified cache reuse with no
  download/recompile. SHA-256 and nanosecond mtimes remained unchanged for 3/3 helper/
  library files, checked by an independent before/after Node assertion.
- `pnpm run lint`, `pnpm run typecheck:scripts`, `pnpm run typecheck:main`,
  `pnpm run typecheck:tests`, and `git diff --check`: passed.

Issues resolved: the initial minimum-OS parser matched unrelated dylib version fields;
it now reads only OS load-command fields. A rate-edge test used a fractional floating
coordinate; it now uses the contract's integer anchor. The cache test initially used
`import.meta` under the project's CommonJS type target; its canonical require seam now
passes runtime and type checks. Decoded read I/O and truncated input use distinct exit
categories. No unrelated failures remain.

Not checked in M1: consumer cancellation/cleanup, admission/ENOSPC races, production
WAV cutover (M2), full suite, signed packaged loading, real speech/listening and hardware
capture (M3). Existing `resolveBundledBinary` resolves app-relative resources for M2;
no new resolver or runtime installation path was added.

Commits: `e35644dbd8c38a56e3ffeaa0f2bf3b43d1e5d424` — M1 native implementation, build inputs and tests.
The verification log is committed separately after recording the implementation hash.

## M2 — Shared consumer cutover and lifecycle

Status: blocked

Implemented the shared native cutover and its operation-owned file/child lifecycle for
all four layouts. Independent verification passes, but M2 cannot satisfy preservation
of valid tiny historical Opus epochs with the current decoded-input contract.
The orchestrator confirmed that this must return to a plan/user decision; it is not an
approved exception to format support.

Contract sync: M1's mapper/helper and exact decoded coverage remain binding. M2 uses
`INPUT MAPPING OUTPUT EXTENT INPUT_FRAMES create|add`, mono float timelines and native
exit categories 2/3/4/5. Alignment selection, conservative provenance, fixed anchors,
rate limits, rejected gaps/overlaps, generation resets and the two-sample run-end bound
are unchanged. No native/M1 contract, capture, schema, provider, scheduler, recovery,
UI or completed-artifact change was made.

Completed work:

- Replaced the per-range FFmpeg graph with one decoder/correction sequence per epoch.
  Each source stays ordered; at most two source decoders run concurrently. Assembly
  uses a fixed number of source timelines with 24 kHz PCM16 output, existing mono
  half gain, mic-left/system-right stereo and unity-gain individual tracks.
- Added private 0700 operation directories under managed `derived`, with UUID paths
  owned by MeetingRecordingStorage. Decoded files/mappings are released after each
  epoch; corrected timelines are removed after closed final assembly and before WAV
  validation/publication. Existing final paths, cache validation, leases and lifetimes
  remain unchanged. Startup's existing derived cleanup handles abandoned directories.
- Peak admission is corrected-timeline bytes plus the larger of concurrent decoded
  epochs/mappings or final WAV/header bytes, based on actual selected sources and
  epoch lengths. It is not a reservation or fixed GiB/hour rule. Later ENOSPC fails
  only the affected operation and removes unpublished files.
- Owned detached child groups stop on first failure/abort. Promises settle on close,
  including spawn errors; source outcomes are all awaited before operation cleanup.
  Local failures use `audio-preparation-failed` / `audio-preparation-disk-full`, the
  existing failed/Retry path and actionable local messages. Bounded child stderr is
  retained as a cause, without resampler details in normal error messages.
- Traced ASR/ensureAudio, playback, mixed/source export and part composition. Their
  public results, strict mixed/selected-source rules and caller ownership are intact.
  Quit leaves interrupted work pending as before; audio/note deletion cancels it.

Final independent verification (serialized):

- `pnpm test --verbose test/cases/recording/integration/meetingAudioPipeline.test.ts test/cases/recording/integration/meetingAlignmentPersistence.test.ts test/cases/recording/integration/meetingSourceExportAlignment.test.ts test/cases/recording/integration/meetingIntentionalIntervals.test.ts test/cases/recording/integration/meetingNoteAudioContinuity.test.ts test/cases/recording/integration/meetingPlaybackLease.test.ts test/helpers/meetingProcessing.test.ts test/helpers/meetingRecordingStorage.test.ts`:
  158 passed, 0 failed, 0 skipped; canonical runner wall time 11.896 s.
- Evidence includes real Opus → native helper → PCM16 WAV in all layouts, independently
  decoded source sums/gain/channels, exact extent and silence, decode-once/source order
  and <=2 concurrent decoders, original SHA-256 and protected result bytes, selected
  export with invalid peer, late ends, overlap, mute, cache reuse, pre-abort/mid-decode/
  mid-correction/final-publication abort, child-error and failed-decoder peer settlement,
  native exit categories, truncated decoded input, admission/write/publication ENOSPC,
  two admitted competing operations with one succeeding, invalid final WAV rejection,
  real worker quit/audio/note barriers, restart cleanup and historical non-retry.
- `pnpm run lint`, `pnpm run typecheck:main`, `pnpm run typecheck:tests`, and
  `git diff --check`: passed. The final lint follow-up changes spacing only.
- Earlier targeted failures were resolved without production tolerance/policy changes:
  the graph-only mock now verifies real execution with ordinary-length epochs, and
  the quit test asserts the existing pending state rather than inventing cancellation.

Blocking reproduction (synthetic data only; existing bundled decoder is FFmpeg 6.0,
libswresample 4.10.100; M1's separate native library remains FFmpeg 8.1.1):

1. Write two PCM16 mono frames `[1, 2]` at 24 kHz, then run the existing
   `convertMeetingPcm` encoder/migration function. It returns 2. The unchanged
   `inspectMeetingOpus` reports `{frameCount:2, ignoredTrailingBytes:0, errorCode:null}`.
2. Decode that exact valid Opus with bundled FFmpeg:
   `-nostdin -hide_banner -loglevel error -i INPUT.opus -ar 48000 -ac 1 -c:a pcm_f32le -f f32le pipe:1`:
   exit 0, 4 float frames.
3. Change only `-ar` to `24000` (the production M2 decoder request): exit 0,
   0 float frames. M1 correctly rejects this empty decoded file with exit category 3
   before creating its timeline. The new operation fails, keeping originals intact.
4. Replay the old production graph on that same file, with a two-frame source and
   24-frame recording extent:
   `[0:a]aresample=24000,atrim=start_sample=0:end_sample=2,asetpts=PTS-STARTPTS,apad=whole_len=2,atrim=end_sample=2,adelay=0S:all=1,volume=0.5[a0];[a0]amix=inputs=1:duration=longest:dropout_transition=0:normalize=0,apad=whole_len=24,atrim=end_sample=24[out]`:
   exit 0, valid 24-frame PCM16 WAV, all silence. Thus this is a previously successful
   preparation case, not corrupt source data. A longer meeting containing such an
   epoch can also fail the new preparation.

The conflict is between preserving that valid historical input and M1's explicit
full decoded coverage rule, which forbids using the endpoint-rounding allowance to
accept absent input. No padding, alternate filter/decoder path, tolerance relaxation,
new cap or unilateral native-contract redesign was applied. Do not mark M2 done or
start M3 until the decoding contract is resolved and verified.

Commits: `23792c7a1af5da9148643532d980f544f4904be5` — M2 implementation and tests.
Shared-index collision: the orchestrator's plan commit included the five staged M2
files along with its orchestration-table update. The existing commit is preserved;
no reset, amendment or history rewrite was attempted. This report is committed
separately. Current PlanAct `ACT.md` and `implementer_worker.toml` were re-read after
the user updated the workflow; M2 remains blocked, and M3/reviews were not started.
