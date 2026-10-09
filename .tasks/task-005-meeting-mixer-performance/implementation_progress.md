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
