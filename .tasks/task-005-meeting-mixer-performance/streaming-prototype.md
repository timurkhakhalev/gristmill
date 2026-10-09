# Continuous-resampler experiment

The user authorized a standalone prototype after Brainstorm. No application
implementation, task branch, Draft, Plan, commit, PR or installed bundle changed.

## Executable experiment

- Runner: `test/benchmarks/meeting-resampler.mts`
- Native core: `test/benchmarks/meeting-resampler.c`
- Repeat: `node test/benchmarks/meeting-resampler.mts 600 3600 7200`
- Machine-readable evidence: `streaming-prototype-results.json` beside this file

The runner compiles the core into an owned temporary directory. It uses already
installed development libraries, not a new application dependency. Environment:
macOS arm64, Node v24.12.0, bundled FFmpeg 6.0 decoder, local libswresample 6.3.101
and libavutil 60.26.101. Packaging this core would need a deliberate library and
distribution decision; these libraries differ from the application's FFmpeg.

Each source is decoded once into float PCM. One persistent resampler processes
bounded buffers and updates its compensation at calibration boundaries. It flushes
and resets only at an explicit discontinuity. Corrected float tracks are joined
into the existing 24 kHz stereo PCM16 WAV shape. The prototype uses temporary files
between stages; it is continuous signal processing, not a zero-copy pipe pipeline.

## Measurements

Two sources, changing drift up to +/−200 ppm on one and +/−120 ppm on the other,
one calibration range per four seconds, two explicit discontinuities per source:

| Recording duration | Ranges per source | Preparation wall time |
| --- | ---: | ---: |
| 10 minutes | 150 | 2.148 seconds |
| 60 minutes | 900 | 12.000 seconds |
| 120 minutes | 1,800 | 23.903 seconds |

The hour was repeated after adding process-wide resource measurement and boundary
continuity checks: **11.931 seconds**, approximately **15.0 child CPU-seconds**,
and **17.1 MiB** maximum individual child RSS. The resampler processes themselves
peaked below 8 MiB. The reported maximum excludes Node and is not the memory of the
installed application. No whole-machine battery consumption was measured.

The measured preparation includes two Opus decodes, resampling, intermediate I/O
and final WAV assembly. Fixture synthesis/Opus encoding and oracle verification
are excluded because saved meeting audio already exists before preparation. These
are individual runs, not p95 latency estimates. The older mixer stand used a
different fixture; do not turn these results into an exact A/B speedup ratio.

For the repeated hour: decode 8.098 seconds, resample 2.806 seconds, final join
0.981 seconds. This identifies decoding as the largest remaining measured cost.
The prototype uses roughly one GiB of temporary files per recording hour plus
Opus originals. There is no disk-space admission check in this experimental runner.

## Correctness evidence

- All 1,800 marker positions in the hour, and all 3,600 positions in the two-hour
  case, were found on the intended channels. Largest observed error: eight samples
  at 24 kHz, or 0.333 ms. This is a synthetic-fixture result, not measured hardware
  clock accuracy. The assertion budget is 96 samples (4 ms).
- Final duration is exact. Known initial/internal/trailing gaps contain silence.
- Original Opus hashes are unchanged.
- Tone energy and adjacent-sample steps around continuous calibration boundaries
  pass. The repeat-hour largest step was 0.003174 in normalized PCM units, under
  the 0.02 guard. This is not a listening test or a speech-quality certification.
- Resampler flushing differed from target endpoints by at most one sample in
  observed runs. The experimental core rejects differences above two samples;
  it bounds writing to the requested extent and leaves any missing endpoint sample
  silent. This rounding policy is not an approved production contract.
- Overlapping output mapping, source-coverage holes and truncated input fail
  before an output is created.
- The timeout guard kills the owned FFmpeg process group. The final smoke checks
  whole-group exit and temporary-directory removal. It passed after the final
  instrumentation changes.

Native code compiled with `-Wall -Wextra -Werror`. A standalone strict TypeScript
check of the runner passed. `git diff --check` passed. There is no application
behavior change requiring a release build or full-suite run.

## Boundaries and recommendation

The experiment validates the basic performance and timing hypothesis. It does not
yet adapt real `alignedAudioRanges`/SQLite metadata, validate its uncertainty or
generation provenance, support overlapping mappings or generation changes without
gaps, exercise all provider/export layouts, or test real speech and packaged native
delivery. Its mapping format is an internal fixture input, not a proposed public
contract. Unknown alignment must remain an error at the existing application
boundary; this experiment does not authorize guessing it.

Continue the design discussion with continuous resampling as a demonstrated
candidate. Before production implementation, settle the saved-alignment adapter,
overlap and discontinuity semantics, native library delivery, temporary-space
budget and independent real-audio verification. The observed hour result supports
a practical seconds-scale target, but a production acceptance budget still needs
representative recordings and repeated measurements.
