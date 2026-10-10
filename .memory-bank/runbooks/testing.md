# Test runner and fixtures

Read this when adding or moving tests, changing compiler probes, or using the renderer harness.
Check selection policy lives in [quality steering](../steerings/quality.md); command semantics live in [project commands](../steerings/project-commands.md).

## Domains and kinds

- Select behavior with `--domain` and the test environment with `--kind`.
- The executable registry owns membership and main-build requirements. This document does not keep a second list of test files.
- A test can belong to several domains. It runs one time.
- Selection is explicit. It is not automatic impact analysis.

| Domain          | Behavior                                                           |
| --------------- | ------------------------------------------------------------------ |
| `notes`         | Notes, editor, folders, search, imports and note output            |
| `recording`     | Capture, microphone and system tracks, Stop, recovery and speakers |
| `transcription` | Files, transcription routes, queue, diarization and cancellation   |
| `calendar`      | OAuth, events, reminders, availability and meeting cards           |
| `ai`            | Models, providers, chat, tools and generated content               |
| `settings`      | Preferences, migrations, secrets and onboarding                    |
| `platform`      | Electron, windows, builds, runtime and shared infrastructure       |

| Kind          | Test environment                                                         |
| ------------- | ------------------------------------------------------------------------ |
| `unit`        | Pure logic or isolated behavior with mocked dependencies                 |
| `integration` | Real database, file system, renderer harness, subprocess or IPC contract |
| `types`       | TypeScript compiler probes. A file can also contain runtime assertions   |
| `native`      | GUI, Swift or native helpers, or OS process integration                  |

- Classification is for each file. For mixed files, use the stronger requirement.
- On macOS, a selection with native tests runs `compile:native` before the tests. The build checks cached helpers and compiles missing or changed binaries. A failed helper build stops test execution.
- A unit selection gives a fast development loop. It does not replace the integration, type or native checks that the changed behavior needs.
- For a local change, start with the least expensive related kind. Before completion, add the checks that the scope table requires.
- For public contract changes, include type and integration checks for consumers.
- For cross-domain changes, select each affected domain, or the full suite when you cannot set the limits of the effect.
- Read the diff and the consumers. Do not guess a domain only from a file name.

```sh
pnpm test --domain calendar --kind unit --list
pnpm test --domain calendar --kind unit
pnpm test --domain calendar --domain notes
```

### Test locations

- Write new ordinary tests and shared test helpers in TypeScript.
- Keep deliberate compiler-error fixtures under `test/scripts/type-probes/`. The probe runner examines their expected diagnostics. The regular strict test typecheck excludes these fixtures.
- Put new ordinary tests under `test/cases/<domain>/<kind>/`. The runner finds their domain and kind without a path registration.
- A `main/` subdirectory marks compiled main and preload consumers. `serial/` marks a shared-resource test.
- Use `test/test-groups.json` for tests that need several domains or a non-standard location. Update those entries when you rename or remove tests or change their dependencies.
- Unknown locations and stale, duplicate or invalid registrations fail before runtime preparation.
- Mark consumers of compiled main and preload output with `buildMain: true`. The runner builds one time if a selected test needs it.
- Use narrow patterns only for tests with the same domain and environment contract.

## Real Electron capture path

```sh
pnpm run build:main
node test/benchmarks/meeting-capture.mts e9e5a37ae
node test/benchmarks/meeting-capture.mts
node test/benchmarks/meeting-capture.mts --soak-seconds=3600
node test/benchmarks/meeting-capture.mts --microphone
```

This fixture sends a synthetic tone through real Web Audio, the capture pipeline, Electron IPC, SQLite and FFmpeg. It uses a temporary profile and no microphone or provider. Both synthetic sources use the renderer path; it does not exercise the native system-audio helper or physical clock calibration.

The `--microphone` mode checks one Start/Stop with the physical microphone and a synthetic system track. It runs only if Electron already has microphone permission; it does not request a permission change. It uses the same temporary profile and does not call a provider. This mode does not check the native system-audio helper.

The Git ref replaces only `meetingAudioPipeline.ts`. Use a revision with the old packet-ordering defect to reproduce that failure. The default run checks repeated Start/Stop, mute/unmute, and 1, 3 and 6 second ACK or renderer stalls. A stall beyond the five-second buffer must report overflow and retain accepted audio. Short stalls must drain. A fresh Web Audio graph settles its render clock after the first quantum in this fixture. Capture preserves the short initial epoch and the explicit startup gap. If the first epoch is shorter than one packet and the gap is at most one packet, normal Start/Stop must finish as ready. Later or larger gaps remain incomplete.

The report includes write and end-to-end ACK latency, maximum queued frames, process CPU and memory, and saved frame counts. It also decodes the longest epoch of each source and checks its frame count and audible signal. The soak option records in real time and prints progress every 30 seconds. Its timeout is the selected duration plus two minutes. Temporary profiles retain only the synthetic audio and measurements for inspection.

## Compiler and renderer fixtures

### Type probes

- For compatible compiler checks, add fixtures to an existing group under `test/scripts/type-probes/`. Do not start another compiler program.
- A `<group>.test.ts` file calls `test/lib/typeProbeBatch.ts`. Its `<group>-NN.ts` fixtures name each case and list its expected diagnostic codes.
- Keep those codes and the clean implementation-graph check of the batch helper when you change probes.
- Register a new group test in `test/test-groups.json` with its domain and the `types` kind.
- An ordinary `types` test under `test/cases/<domain>/<kind>/` does not go into the batch. The runner selects batch groups by their `test/scripts/type-probes/` path.
- Keep separate compiler programs when compiler options are not compatible or when fixtures change implementation sources. Do not combine those environments until you prove that they can share one program.

### Shared main-process harness

- Use `test/helpers/harness/bundledPreload.ts` to run the emitted preload in a sandbox. Do not copy a preload loader into a test file.
- When the better-sqlite3 binding cannot load, call `skipOrFail` from `test/helpers/harness/nativeBinding.ts`. It skips locally and fails when `REQUIRE_DB_TESTS` is set. Do not write a local skip check.
- Use `test/helpers/harness/db.ts` for a temporary `DatabaseManager`. It installs the electron stub when it loads.

### Renderer tests

- Import pure renderer modules directly when this keeps the tested behavior.
- Use the existing `test/lib/rendererTestHarness.ts` when you need Vite SSR, browser globals or module mocks. DOM constructor globals use exact descriptor snapshots and register restoration before setup mutations. Unmount React roots before restoring the globals that their cleanup uses.
- Compatible cases in one file can share a Vite server. Restore stores, globals, mocks and singleton state between cases.
- Keep different module-mock environments separate until their isolation is proved.
- Do not disable test process isolation globally.

## Recording performance without a meeting

Run the synthetic database and alignment workloads:

```sh
GRISTMILL_CAPTURE_BENCH_REPORT=/tmp/gristmill-capture.json pnpm test --verbose test/cases/recording/integration/meetingCapturePerformance.test.ts test/cases/recording/unit/meetingAudioAlignmentPerformance.test.ts test/cases/recording/integration/meetingCompanionDemand.test.ts
```

The capture fixture seeds metadata for 0, 5, 53 and 120 minutes in a temporary database. It measures real capture-session writes and checks that packet processing keeps up with the 100 ms arrival interval. It counts PCM frames instead of encoding audio. The alignment fixture checks full frame coverage after two hours. These tests do not use a microphone, call service, provider or production profile.

Each duration measures 100 packets and reports median, p95 and maximum write time. To reproduce the old duration-dependent database cost, set `GRISTMILL_CAPTURE_BENCH_REF` to a Git revision before the optimization. The fixture loads that revision's database read/write methods and removes the new coverage index in its temporary database only. All other fixture code and dependencies stay the same. The old revision is expected to fail the processing-budget assertion; the JSON report is written before that assertion.

`pnpm test --verbose test/cases/recording/unit/meetingCaptureBackpressure.test.ts` runs the actual AudioWorklet with a virtual render clock and serial write acknowledgements. It reproduces overflow with 150 ms writes, then checks two virtual minutes with 1 ms writes. The selected latencies are workload assumptions; the separate database benchmark measures the current write cost.

Measure the floating recording window in isolated Electron processes:

```sh
node test/benchmarks/meeting-companion.mts e9e5a37ae
node test/benchmarks/meeting-companion.mts
```

The optional Git ref selects the component and synchronization hook from that revision. Both runs use the current dependencies, CSS and benchmark shell. Each run uses the same synthetic audio-level function, a temporary profile, a warm-up, and separate visible and hidden samples. The command prints the path to CPU and wakeup measurements. The same directory contains `visible.png` for visual inspection. The current-code run fails if the hidden window still sends level updates.

Run A/B measurements sequentially with other builds and tests stopped. Repeat them if host load changes. These samples compare the measured component; they do not measure whole-Mac battery savings or prove physical audio capture. Native device changes, permissions and real audio still require the related hardware smoke test.

### Post-Stop mixer performance

The short smoke seeds a private database and calls production preparation for all
four layouts. It covers calibration, epoch/generation resets, gaps and overlapping
contributions. Native tests currently run locally on macOS; Linux CI does not prove
native delivery or hardware capture.

```sh
pnpm test --verbose test/cases/recording/integration/meetingMixerPerformance.test.ts
pnpm test --verbose test/cases/recording/integration/meetingPrivateFixtureReplay.test.ts
node test/benchmarks/meeting-resampler.mts 600 3600 7200
node test/benchmarks/meeting-resampler.mts 3600 7200
node test/benchmarks/meeting-resampler.mts 3600 7200
```

Build native resources first with `pnpm run compile:native`. Prepare the canonical
Electron SQLite ABI with the focused test command. The benchmark always launches
Electron Node mode and never rebuilds bindings. Stop competing tests, builds and
benchmarks before large measurements. Run the three commands sequentially.

Synthetic sources contain separate tones and pulse markers, calibration every
four seconds, opposite 200 ppm drift, explicit gaps, three epochs and an overlap.
An independent analytical signal checks output windows at calibration, generation,
gap and overlap boundaries. The fractional-delay oracle retains a 0.8 threshold,
the full allowed lag search, an analytical half-sample shift control and a damaged
window negative control. Source hashes must remain unchanged.

Timing includes production decoding, native preparation, intermediate I/O and
final WAV assembly. Fixture generation, waveform checks and excerpts are outside
timing. `/usr/bin/time -l` measures summed child CPU and maximum individual child
RSS; these exclude the Electron coordinator. The stand samples allocated bytes
under managed derived storage every 25 ms and at child close. This is a measured
peak, not a disk reservation or a whole-machine battery measurement. Every hour
run must take at most 30 seconds and every two-hour run at most 60 seconds on the
measured Mac. Preserve hardware, revision and native build manifest with results.
Do not infer an exact speedup from a historical stall on a different fixture.

Production mapping decisions provide candidate/accepted/rejected counts,
exclusive rejection reasons (uncertainty before effective rate), absolute anchor
corrections and separate boundary resets. Accepted share is unavailable when
there are no candidates. There is no minimum accepted-share target.

### Private copied recordings

The user must select a specific recording. The copy and detailed evidence must
stay outside the checkout and CI, with directory mode 0700 and file mode 0600.

```sh
python3 test/benchmarks/copy-meeting-for-prototype.py PROFILE NOTE_ID NEW_DIRECTORY
node test/benchmarks/meeting-resampler.mts --copied-fixture NEW_DIRECTORY
```

The exporter reads selected raw rows in one read-only WAL transaction. It keeps
JSON text and decimal nanoseconds unchanged and copies only selected audio, with
hashes before and after copying. Readable WAL sidecars are required. Changed or
deleted audio fails explicitly. It does not migrate, copy a raw database, write
the source profile or use immutable mode.

Replay inserts raw rows and minimal note context into `createDb`, then reads
recordings, epochs and intentional intervals through production DTO validation.
All layouts use production preparation. The private report contains actual mapper
decisions, source hashes and fractional waveform comparisons against independent
48 kHz decoded contributions, including summed overlap windows. Five-second
excerpts and their category index stay in the external evidence directory.
Absent real boundary categories remain covered by synthetic checks.

Do not publish identities, times, durations, exact counts, hashes, excerpts,
transcripts or window measurements. Only reviewed aggregate pass/fail and a
rounded acceptance share may leave the private directory. Human listening must
be recorded separately; an automated pass cannot claim listening or hardware
permission approval. See [local builds](local-builds.md) for isolated package
capture, playback, export and cancellation checks.
