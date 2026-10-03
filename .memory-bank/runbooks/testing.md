# Test runner and fixtures

Read this when adding or moving tests, changing compiler probes, or using the renderer harness.
Check selection policy lives in [quality steering](../steerings/quality.md); command semantics live in [project commands](../steerings/project-commands.md).

## Domains and kinds

- Select behavior with `--domain` and the test environment with `--kind`.
- The executable registry owns membership and main-build requirements. This document does not keep a second list of test files.
- A test can belong to several domains. It runs one time.
- Selection is explicit. It is not automatic impact analysis.

| Domain | Behavior |
| --- | --- |
| `notes` | Notes, editor, folders, search, imports and note output |
| `recording` | Capture, microphone and system tracks, Stop, recovery and speakers |
| `transcription` | Files, transcription routes, queue, diarization and cancellation |
| `calendar` | OAuth, events, reminders, availability and meeting cards |
| `ai` | Models, providers, chat, tools and generated content |
| `settings` | Preferences, migrations, secrets and onboarding |
| `platform` | Electron, windows, builds, runtime and shared infrastructure |

| Kind | Test environment |
| --- | --- |
| `unit` | Pure logic or isolated behavior with mocked dependencies |
| `integration` | Real database, file system, renderer harness, subprocess or IPC contract |
| `types` | TypeScript compiler probes. A file can also contain runtime assertions |
| `native` | GUI, Swift or native helpers, or OS process integration |

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

## Compiler and renderer fixtures

### Type probes

- For compatible compiler checks, add fixtures to an existing group under `test/scripts/type-probes/`. Do not start another compiler program.
- A `<group>.test.ts` file calls `test/lib/typeProbeBatch.ts`. Its `<group>-NN.ts` fixtures name each case and list its expected diagnostic codes.
- Keep those codes and the clean implementation-graph check of the batch helper when you change probes.
- Register a new group test in `test/test-groups.json` with its domain and the `types` kind.
- An ordinary `types` test under `test/cases/<domain>/<kind>/` does not go into the batch. The runner selects batch groups by their `test/scripts/type-probes/` path.
- Keep separate compiler programs when compiler options are not compatible or when fixtures change implementation sources. Do not combine those environments until you prove that they can share one program.

### Renderer tests

- Import pure renderer modules directly when this keeps the tested behavior.
- Use the existing `test/lib/rendererTestHarness.ts` when you need Vite SSR, browser globals or module mocks.
- Compatible cases in one file can share a Vite server. Restore stores, globals, mocks and singleton state between cases.
- Keep different module-mock environments separate until their isolation is proved.
- Do not disable test process isolation globally.

