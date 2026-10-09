# Parallel decode experiment

Run: `node test/benchmarks/meeting-resampler.mts --compare-decode 3600 7200`.
The same generated Opus files are processed sequential/parallel/parallel/sequential.
Only decoding is parallel; native correction and final assembly remain sequential.
Both variants decode both inputs before correction, so stage order is otherwise equal.
Fixture generation and validation are outside the wall-time interval.

| Duration | Sequential wall seconds | Parallel wall seconds | Mean reduction |
| --- | --- | --- | --- |
| 60 minutes | 12.289, 11.659 | 8.396, 8.217 | 30.6% |
| 120 minutes | 23.898, 24.690 | 16.108, 16.129 | 33.7% |

Mean child CPU seconds: 15.059 → 16.064 for one hour, 30.558 → 31.395
for two hours. Faster completion is not evidence of lower energy consumption.
Maximum individual decoder RSS is about 16 MiB. The sum of two decoder peak RSS
values is at most 32.5 MiB in these runs; this is an upper bound, not a sampled
simultaneous peak, and excludes the runner and application. Temporary float files
still scale with recording length.

All variants pass the independent timing/channel/gap/continuity checks. Maximum
marker error stays 8 samples (0.333 ms), final duration is exact, original hashes
stay unchanged. These fixtures still have perfectly adjacent calibration joins.

`node test/benchmarks/meeting-resampler.mts --compare-decode 8` also passes the
paired-process failure guard: timeout of one process stops the peer, waits for both
groups to exit, then removes owned temporary files. Strict standalone TypeScript
checking and `git diff --check` pass. No application code or installed app changed.

## Calibration join diagnostic

The same smoke adds two source-contiguous intervals with timeline mismatch of
−50, −1, +1 or +50 samples. Negative mismatches are rejected as overlap. Positive
mismatches are accepted as two separate continuous runs, even for one sample.
This confirms the prototype cannot yet distinguish calibration jitter from a real
discontinuity. Zero-valued input is used for this structural diagnostic; it does not
prove audible clicks or their absence. No smoothing rule was implemented.

## Decision supported by evidence

Parallel decode has a measured benefit with modest additional decoder memory.
Include it when revising the plan. Resolve calibration continuity using source
provenance and timing evidence before production integration; do not erase real
gaps by treating every small mismatch as jitter. The current plan has not been
revised or reapproved by this experiment.
