# Test runner optimization: issue #93, TS6 stage

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

The final run is a warm local checkout, with the dependencies and compiled
native runtime already present. Its runner phases were 0.55 s preparation,
20.01 s main build, 228.28 s ordinary files, 12.33 s grouped type probes,
and 40.80 s other serial files. It sampled process-tree RSS and CPU about once
per second; the monitor would stop the run above 3 GiB RSS or 512 MiB swap
growth. Swap stayed at 5308.5 MiB. `pmset -g therm` reported no recorded thermal
or performance warning after the run. These samples do not establish a thermal
or continuous memory-pressure bound. The 120 s target is **not achieved** on
TS6 by these changes; do not treat the focused renderer savings as a full-suite
result.

The strict renderer typecheck separately passed in 5.52 s wall time; the
required full test plus renderer check therefore took 308.82 s. The full
`pnpm run typecheck` sequence passed in 8.58 s. `pnpm run lint` passed with
existing warnings. The full-run lock was absent afterward. A fresh checkout
with missing native runtime would also include any required preparation or
rebuild; that cold condition has not been measured here.
