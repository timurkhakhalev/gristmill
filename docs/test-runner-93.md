# Test runner optimization: issue #93, TS6 stage

## Final result and measurement conditions

The final #93 TS6 run of `pnpm test -- --processes 2` passed 2753 cases across 388
files in 60.43 s. The separately required `pnpm run typecheck:renderer` passed
in 5.84 s, for 66.27 s combined against the 120 s target. This was a warm local
checkout with installed dependencies and a healthy native SQLite runtime; a
cold native rebuild was not forced or measured. Process-tree memory and swap
were sampled about once per second, and `pmset -g therm` recorded no thermal or
performance warning after the run. Those observations do not establish a
continuous thermal or memory-pressure bound. The stages and measurements below
record how this result was reached.

## Starting point

The starting point was merged `main` at
`85e939894ac49f9e8663465130079b642981823b`: 388 test files, 2749 passing
cases, and 452.60 s wall time including SQLite preparation and `build:main`.
Issue #93 targets 120 s for the full required check. The TS7 migration was
excluded from this stage by the owner.

## Changes

- `run-tests.js` now bounds shutdown of its own process groups, including a
  surviving descendant when the direct child exits. A TERM-ignoring child or
  grandchild receives SIGKILL after one second. Lifecycle tests cover normal
  completion and interruption; the full-run lock is released after owned
  processes exit.
- 57 strict TS6 type probes from 21 files use one compiler program. Each
  fixture retains its original test name and exact expected diagnostic codes.
  Diagnostics in imported implementation files also fail the group. A
  temporary change that removed an expected error failed its focused test.
- Compatible renderer fixtures reuse one Vite server per file with explicit
  module invalidation and per-case browser/store cleanup. Files with different
  mock modules continue to use separate servers.
- New ordinary tests under `test/cases/<domain>/<kind>/` are discovered without
  editing the file registry. `main/` and `serial/` subdirectories set their
  runtime requirements. Existing multi-domain and exceptional classifications
  retain their exact registry entries. Unknown locations fail before setup.

The current 15 `test/utils` files that do not use fake timers or obvious
global/module loader mutations took 4.57 s with ordinary isolation and two
workers (`pnpm test --` with those exact files). Grouping these would save at
most a small fraction of the remaining gap, so they remain isolated. A broader
unit-file group has not been proven safe.

## Measured results

| Snapshot | Command | Pass / fail / skip / cancel | Wall time | Peak descendant RSS | Peak CPU | Swap growth |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| #94 merged baseline | `pnpm test -- --processes 2` | 2749 / 0 / 0 / 0 | 452.60 s | 1334 MiB | 224% | 0 MiB |
| Type batch and first Vite changes | same | 2752 / 0 / 0 / 0 | 321.61 s | 1198 MiB | 232% | 0 MiB |
| Additional Vite changes | same | 2753 / 0 / 0 / 0 | 296.57 s | 1089 MiB | 224% | 0 MiB |
| Final integrated run | same | 2753 / 0 / 0 / 0 | 303.30 s | 1216 MiB | 229% | 0 MiB |

That intermediate run is a warm local checkout, with the dependencies and compiled
native runtime already present. Its runner phases were 0.55 s preparation,
20.01 s main build, 228.28 s ordinary files, 12.33 s grouped type probes,
and 40.80 s other serial files. It sampled process-tree RSS and CPU about once
per second; the monitor would stop the run above 3 GiB RSS or 512 MiB swap
growth. Swap stayed at 5308.5 MiB. `pmset -g therm` reported no recorded thermal
or performance warning after the run. These samples do not establish a thermal
or continuous memory-pressure bound. At this intermediate TS6 stage, the
120 s target was **not yet achieved**; focused renderer savings were not a
full-suite result.

The strict renderer typecheck separately passed in 5.52 s wall time; the
required full test plus renderer check therefore took 308.82 s. The full
`pnpm run typecheck` sequence passed in 8.58 s. `pnpm run lint` passed with
existing warnings. The full-run lock was absent afterward. A fresh checkout
with missing native runtime would also include any required preparation or
rebuild; that cold condition has not been measured here.

## Final stage: default run under 120 seconds

The next profile measured actual process lifetime for all 367 independently
launched test files, alongside top-level case times. The 357 ordinary files
totalled 325.6 s of process lifetime across two workers: 232.3 s in cases and
93.3 s outside cases. The ten serial files totalled 36.6 s, with 30.7 s in
cases. The most expensive processes were `meetingFileTranscriptionPicker`
(11.35 s), `byokResumeDraft` (10.03 s), `spacesTreeNoteActionClearance`
(9.09 s), `notesContract` (9.07 s), `useChatStreamingCancellation` (8.12 s),
`onboardingCompatibility` (6.85 s), `orukeetOrganization` (6.48 s),
`reasoningServiceOpenCodeSession` (6.00 s),
`meetingRecordingStoreDiarizationPublish` (5.56 s), and `meetingResultsPanel`
(5.48 s). These are overlapping file lifetimes, not additive wall time.
`llamaServerContext` spent 5.12 s after its cases because a fake process left
a real five-second shutdown timer pending.

The fixture now tests context reset without that fake process. Focused process
time fell from 5.23 to 0.29 s, with all 11 cases intact. One Vite server per
file and fresh settings-store modules reduced `byokResumeDraft` from 9.63 to
5.96 s and `useChatStreamingCancellation` from 8.99 to 3.66 s in focused
process measurements. Five renderer and two main `notesContract` type probes
now use one compiler program per target, preserving their separate expected
diagnostics and a clean implementation-graph check; focused process time fell
from 9.07 to 4.39 s. The other renderer fixtures kept their distinct mock
environments: in the final scheduling mode, the picker took 1.64 s and
`meetingRecordingStoreAutoEndStop` 0.64 s as complete files.

The largest gain came from scheduling. `run-tests.sh` had placed every macOS
test, build and compiler process under `taskpolicy -b nice -n 15`. The same
`build:main` took 21.45 s there and 2.90 s at normal priority. The canonical
`pnpm test` command now calls the existing runner directly. The two-process
limit, serial phases, SQLite preparation, process-group cleanup and full-run
lock remain in the runner. No incremental build cache or shared-process pool
was added: a clean main build is about 3 s at normal priority, and the target
is met without extra state or fixture isolation risk.

| Full-run snapshot | Command | Pass / fail / skip / cancel | Test wall | Peak descendant RSS | Peak CPU | Swap growth |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| First normal-priority experiment | `OPENHERCULES_TEST_BACKGROUND=1 pnpm test -- --processes 2` | 2753 / 0 / 0 / 0 | 62.52 s | 1011 MiB | 261% | 0 MiB |
| Final default command | `pnpm test -- --processes 2` | 2753 / 0 / 0 / 0 | **60.43 s** | 1249 MiB | 276% | 0 MiB |

The first row used the former wrapper's bypass variable only as an experiment;
that variable is no longer needed. The final run covered 388 files. Its phases
were 0.08 s preparation, 3.00 s main build, 45.47 s ordinary files, 2.02 s
batched type probes and 9.58 s remaining serial files. The separately required
`pnpm run typecheck:renderer` passed in 5.84 s: **66.27 s combined**, below
the 120 s target. `pnpm run typecheck` passed in 9.08 s; `pnpm run lint`
passed with existing warnings. The full-run lock was absent afterward.
The monitor sampled the process tree and swap about once per second and would
terminate its own run above 3 GiB RSS or 512 MiB swap growth. Neither limit
was reached. `pmset -g therm` reported no recorded thermal or performance
warning after the run. These samples do not establish a continuous thermal
bound. The result is for an installed, healthy SQLite runtime; a cold native
rebuild was not forced or measured and would add preparation time.
