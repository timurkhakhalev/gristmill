# Mixer performance investigation

## Scope and reproduction

The stand is `test/cases/recording/integration/meetingMixerPerformance.test.ts`.
Commands and parameters are in `.memory-bank/runbooks/testing.md`, under
“Post-Stop mixer performance”. Raw measurements from this session are in
`measurements.json` beside this document. No application source or installed app
was changed. No production profile, provider, or physical recording was used.

The fixture creates real Opus tones and alignment metadata in a temporary database.
It calls the actual mixer. Prototype graph changes exist only in its injected spawn
function. Each variant gets an uncached output ID. The default regression checks
eight seconds, eight mic ranges, alternating ±200 ppm rates, initial and internal
gaps, and a separate continuous system source. Large measurements are opt-in.

## Findings

The current mixer resamples the complete decoded input separately on every split
branch before trimming it. Every retained piece gets leading silence up to its
absolute meeting offset. Hundreds of padded pieces enter `amix`. Both repeated
input processing and the growing filter graph contribute to the cost.

On this Apple Silicon Mac, using bundled FFmpeg 6.0:

| 240 seconds, 60 mic ranges | Wall seconds | PCM versus baseline |
| --- | ---: | --- |
| Current graph | 6.567 | Reference |
| Resample once before split | 2.769 | Identical |
| Resample once + `asegment` | 1.553 | Identical in this case |
| Resample once + concat | 2.484 | Different |
| Resample once + `asegment` + concat | 1.248 | Different |

These are individual measurements, not distribution estimates. The earlier
120-second / 30-range case took 1.469 seconds versus 0.741 seconds for shared
resampling. Doubling both length and range count increased baseline cost by more
than four times. A 120-second / 900-range stress case hit the 20-second limit for
each of the three variants available at that point. A first large run also exposed
the runner's default 30-second test timeout; the stand now sets its own outer limit
and explicitly aborts its owned children on test cancellation.

The full-hour / 900-range reproduction used a 20-second cap per variant:

| Variant | Last observed output, approximately | Sampled RSS maximum, MiB |
| --- | ---: | ---: |
| Current graph | 8 seconds | 396 |
| Shared resampling | 16 seconds | 346 |
| Segmentation | 68 seconds | 325 |
| Concat | 22 seconds | 290 |
| Segmentation + concat | 685 seconds | 258 |

All five exceeded the cap, so this command correctly failed. Output observations
come from file sizes sampled every 250 ms; they are progress samples, not completed
durations or reliable completion forecasts. The final row is an unqualified
prototype, not a usable optimization result. The owned processes were confirmed
gone and temporary data was removed.

## Correctness limits found by the stand

Shared resampling was bit-exact in all completed cases checked so far. Segmentation
was exact with drift in the completed fixtures, but its zero-drift control changed
51 samples by one PCM16 unit; the strict equality check correctly failed. This
needs an explanation of sample-format negotiation/rounding before qualification.
The stand reports differences without treating them as timing failures.

Concat with drift changed 1,790 samples in the eight-second fixture, with a maximum
delta of 5,172 PCM16 units. Normalizing timestamps and explicitly using float samples
did not remove that mismatch. It cannot be shipped on the basis of its speed.
Concat also explicitly rejects overlapping output ranges. Segmentation requires
consecutive source coverage. The prototypes do not yet cover multiple epochs,
multiple recording parts, all export layouts, or overlap mixing semantics.

## Initial bounded-batch candidate

Shared resampling is a small candidate improvement, but alone it leaves the main
scaling problem. Do not declare the incident fixed after that change.

Prototype a bounded preparation pipeline next:

1. Keep the current strict alignment selection and saved meeting frame extent.
2. Decode and resample each original epoch once into a seekable temporary float
   track. Include this temporary space in the disk-space check.
3. Process bounded groups of alignment ranges from that track. Keep whole ranges
   when applying their rate correction so batching does not reset a time-stretch
   operation in the middle of a range. Avoid rereading the whole Opus file per range.
4. Compose the corrected pieces into source tracks, preserving gaps, offsets, and
   additive overlap semantics. Do not quantize to PCM16 before overlap mixing.
5. Produce the existing stereo/mono/source layouts from these tracks. Propagate
   cancellation and clean up only owned intermediates on success and failure.

This is a design candidate, not a measured implementation. The next qualification
needs exact frame placement and channel checks, rate-correction boundary checks,
overlaps, part/epoch restarts, intentional mute, missing-source rejection,
cancellation, disk failure, and the one-hour / 900-range benchmark. Establish an
independent audio oracle for any accepted rounding differences. Do not silently
relax the current comparison to make a faster candidate pass.

## Validation status

The default stand and unsupported-coverage guard pass (2 tests, no skips).
The large capped reproductions and the zero-drift candidate comparison fail for
the reasons above. These are recorded experimental failures, not passing checks.
Application runtime, native capture, live providers, packaging and installation
were not part of this investigation.

## Primary-source research and revised recommendation

The first investigation tested improvements within the existing per-range graph.
The preferred next candidate is now a continuous, timestamp-driven resampler for
each source, followed by bounded two-track composition. Batching remains an
implementation candidate if the current executable interface cannot accept the
required timestamps efficiently; it is not the target audio synchronization model.

Primary sources:

- [GStreamer clocks and synchronization](https://gstreamer.freedesktop.org/documentation/application-development/advanced/clocks.html)
  describes one pipeline clock, timestamped buffers, and mapping device clocks to
  pipeline time. Capture buffers should use the time their first sample was captured.
- [Apple aggregate-device synchronization](https://support.apple.com/guide/audio-midi-setup/set-aggregate-device-settings-ams094c7edb4/mac)
  uses a primary clock and resampling for device drift, even when nominal sample
  rates match. This supports the synchronization principle; it does not establish
  that aggregate devices are the correct capture API for this application.
- [FFmpeg resampler options](https://ffmpeg.org/ffmpeg-resampler.html)
  distinguish continuous stretch/squeeze compensation from hard fill/trim and
  expose thresholds and compensation duration. `async=1` enables fill/trim;
  larger values set the maximum soft adjustment per second.
- [FFmpeg 6.0 libswresample](https://ffmpeg.org/doxygen/6.0/group__lswr.html)
  exposes streaming conversion, timestamp compensation and
  `swr_set_compensation`. The installed FFmpeg 6.0 executable also advertises the
  relevant `aresample` options. Calling the library API directly would require a
  separate integration; the existing executable does not expose that API to JS.

Application-specific inference: frequent calibration measurements should update
the mapping between source samples and meeting time, rather than each becoming a
new full-stream processing branch. Decode each epoch once, feed bounded buffers
with proven timing into a persistent resampler, represent real gaps/restarts
explicitly, then compose the two aligned sources. This aims for work proportional
to decoded audio plus calibration metadata; no performance result proves it yet.

The saved Opus sample-count timeline alone is not the calibrated meeting timeline.
The implementation must pass the saved alignment mapping to the resampler through
timed frames or a suitable API. Adding an `async` flag to the current command cannot
recover timing data that the command does not provide. The timestamp transport,
gap policy, output extent and cancellation behavior must be designed and tested.

Changing from independent `atempo` ranges to continuous resampling intentionally
changes the signal-processing algorithm. A bit-exact comparison with the old output
is useful when rearranging the same operations, but cannot be its only correctness
oracle. Add synthetic known-time impulses/chirps on both tracks, drift ramps, gaps
and restarts; verify event positions, duration, channel identity, continuity and
signal quality independently. Keep the existing baseline comparisons as diagnostics.
