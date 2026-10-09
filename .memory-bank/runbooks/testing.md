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
