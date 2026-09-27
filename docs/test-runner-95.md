# Test runner baseline for issue #95

Measured on 2026-09-27 on Mac16,8 (12 CPUs, 24 GiB), starting from
`fa4374c2cb082591e6e086a94f7b28a23be389a6` plus the issue #95 runner
changes. All three accepted runs used the same 413 registered files and the
same source tree; the default was switched to two processes only after the
measurements. Commands used the canonical `pnpm test` wrapper, including one
SQLite preparation and one main build per run:

```sh
pnpm test -- --processes 1
pnpm test -- --processes 2
pnpm test -- --processes 2
```

| Mode | Wall time including preparation | Results | Peak process-tree RSS | Peak process-tree CPU | Swap growth |
| --- | ---: | --- | ---: | ---: | ---: |
| One process | 704.23 s | 2881 pass, 0 fail/skip/cancel | 1044 MiB | 198% | 0 MiB |
| Two processes, first | 534.42 s | 2715 + 166 pass, 0 fail/skip/cancel | 1214 MiB | 228% | 0 MiB |
| Two processes, repeat | 534.80 s | 2715 + 166 pass, 0 fail/skip/cancel | 1242 MiB | 226% | 0 MiB |

Two processes reduced wall time by 24.1%. The first phase ran ordinary test
files with process isolation and `--test-concurrency=2`; the second ran compiler,
native and marked shared-resource files with `--test-concurrency=1`. SQLite
preparation and main build were outside both phases and ran once. The selected
files executed once each. No test, build or install runs overlapped.

RSS and CPU were sampled from the runner's descendant process tree about once
per second. The safety monitor would stop its owned run above 3 GiB tree RSS or
512 MiB swap growth. Swap was already 5429 MiB at the start and did not grow.
System-wide free memory was 63% before and 61% after the measurements;
`pmset -g therm` reported no thermal or performance warning level. These are
host observations, not continuously sampled memory-pressure or temperature
traces. The full-run lock was released and no runner/test process remained after
each run.

A preliminary one-process run had 2880 passes and one failure because a new
lock test tried to acquire the lock already held by its own full run. The test
was moved to an isolated temporary lock path, passed focused, and the accepted
one-process and two-process measurements above were then run on the corrected
source tree.

Use `pnpm test -- --processes 1` when diagnosing a failure or running on a
resource-constrained host. Issue #94 may change the test count; record a new
full baseline after that work before issue #93.
