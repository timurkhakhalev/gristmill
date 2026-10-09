# Project commands

This document defines what the commands do.
To select checks, use the [quality steering](quality.md).
Run all commands from the repository root.

## Test selection

| Command                                      | Selection                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                  | Full suite, including compiler probes and native and GUI checks. A maximum of two ordinary files at the same time |
| `pnpm test --verbose`                        | The same selection with full live output                                                                          |
| `pnpm test -- --processes 1`                 | Explicit one-process diagnostic mode                                                                              |
| `pnpm test --domain calendar`                | All kinds in one domain                                                                                           |
| `pnpm test --domain calendar --domain notes` | The union of the domains, without duplicates                                                                      |
| `pnpm test --domain calendar --kind unit`    | Unit tests in the domain                                                                                          |
| `pnpm test --kind types`                     | Batch and standalone compiler probes in all domains                                                               |
| `pnpm test --domain calendar --list`         | Read-only plan with kind, domains and build requirement                                                           |
| `pnpm test --help`                           | Available selectors and usage                                                                                     |

### Selector rules

- Repeated domains combine with OR. Repeated kinds combine with OR. Domain and kind filters intersect.
- Unknown options or values, missing values and empty selections fail before the runtime is prepared.
- `--list` validates the test classification. It does not prepare SQLite, build or run tests.
- The runner finds new ordinary tests under `test/cases/<domain>/<kind>/` automatically. Exceptional classifications stay in `test/test-groups.json`.
- Put compiled main and preload consumers under a `main/` subdirectory. Put shared-resource tests under `serial/`.
- No selectors means the full suite.

### Output

- Test and build output is hidden by default. The runner tells you this. It shows the captured output of a failed command.
- Use `--verbose` to show all output while it runs. Selection, exit codes and timing stay the same.

### Explicit files

- For a specific regression, use `pnpm test -- <explicit test files>`. The runner accepts exact registered paths under `test/` that end in `.test.ts`.
- Do not combine explicit files with domain or kind selectors.
- Do not pass directories, globs or Node flags.
- The optional leading `--` also works with selectors.

### Runner behavior

- Executed selections prepare SQLite.
- On macOS, a selection with native tests runs `compile:native` one time before test execution. Missing or changed helper binaries are built; a compilation failure stops the run.
- The runner runs `build:main` one time, only if a selected test needs compiled output. Combine checks in one call. Do not run a separate main build immediately before, when the plan includes it.
- On macOS, tests use Electron Node mode. Linux CI uses Node.
- Ordinary files use a maximum of two isolated processes. Compiler, native and marked shared-resource files run in a later phase with one worker.
- Preparation and the main build each run one time.
- Full runs take a lock in the common Git directory. The lock applies across worktrees.
- Use the canonical command. Direct `node --test` can skip the necessary SQLite runtime setup.
- Selected group tests under `test/scripts/type-probes/` run in their own batch phase with one worker. Only this phase uses `--test-isolation=none`, to share one compiler program from `test/lib/typeProbeBatch.ts`.
- Other `types` tests run in sequence outside this batch. A test under `test/cases/<domain>/types/` does not go into the batch.

## Typecheck, lint and build

- `pnpm run typecheck:main`, `pnpm run typecheck:renderer`, `pnpm run typecheck:settings-selectors` and `pnpm run typecheck:tests` select compiler targets for the native TypeScript 7 `tsc`.
- `pnpm run typecheck` runs those targets, `typecheck:companion`, `typecheck:scripts` and `typecheck:lint-tools` in sequence.
- `pnpm run build:main` uses the same native compiler for emitted Electron code.
- The `typescript` dependency is an alias for TypeScript 6. Compiler API consumers (test probes and the Oxlint tooling in `tools/oxlint`) use it. Its executable is `tsc6`. Keep the CLI and API packages separate until TypeScript 7 supplies a supported programmatic API.
- The test target automatically includes ordinary TypeScript tests and helpers. It excludes intentionally invalid type-probe fixtures.
- A test selection that builds main also examines the main compilation. Other selections do not.
- `pnpm test` runs compiler probes. It does not replace the renderer or test typecheck.
- When a full suite is necessary, also run `pnpm run typecheck:renderer` separately.
- `pnpm run lint` checks the root Oxlint policy with type-aware rules in one pass. Use `pnpm exec oxlint --format json .` for all diagnostics. The root, test and script `tsconfig.json` files inherit the canonical compiler settings so the type-aware engine can discover them. Renderer and extension already have standard config entry points.
- `pnpm run lint:fix` applies ordinary Oxlint fixes. It does not enable suggestions or dangerous fixes. Unfixed errors still produce a failed command.
- `pnpm run lint:policy:test` checks the copied TypeScript quality bundle with valid and invalid consumer examples.
- `pnpm run format:check` is check-only. `pnpm run format` writes supported files with the root Oxfmt configuration. Temporary task files and the copied quality bundle are excluded.
- Oxlint and Oxfmt both exclude `test/**`. This is a decision by the owner, tracked in #278 and deferred to #301; tests keep running and keep passing the compiler. Do not reintroduce test remediation under the old "lint applies to tests" wording, and do not treat an excluded test file as a passing control. Change a test only for the behavior or contract it covers, and select checks for that behavior.
- Run lint fixes before Oxfmt. A second complete pass must not change files. Preserve the separate typecheck and behavior checks; lint does not prove result ownership or resource cleanup.
- Do not use auto-fix across unrelated changed files.
- `pnpm run build:renderer` examines the renderer bundle.
- Packaging is a separate, heavier check. Do it when the package output or native integration is relevant.

## Companion extension

- `pnpm run build:companion` typechecks and bundles the MV3 browser code into `build/companion` and `build/companion-dev`. Load the related channel unpacked in Chrome Stable.
- `pnpm run typecheck:companion` examines the DOM-only extension graph. Browser entries must not import Node or Electron code.
- The native host is a separate entry in `build:main`. It runs with the bundled Electron Node runtime.
- Production packaging copies `build/companion` to `companion` in the app resources. Dev packaging copies `build/companion-dev` to `companion-dev`.
- Each channel uses its own extension identity and native host registration.

## Setup and application verification

- `pnpm install --frozen-lockfile` installs the lockfile snapshot explicitly. The install hook can rebuild native dependencies. Do not run it at the same time as tests or a running app. Node and pnpm requirements: [README](../../README.md).
- `pnpm dev` starts the Vite renderer and the development Electron main process. Its preparation includes the native helpers and the main build. To test app startup against synthetic data, use a temporary explicit profile.
- `pnpm start` runs Electron after the configured preparation steps.
- `pnpm run pack:dev` builds an unsigned development app. Close the packaged Gristmill Dev app first. Ordinary unit tests do not need it.
- `pnpm run build:mac:arm64:local` builds the production app with the persistent self-signed `Gristmill Local Signing` identity from the login keychain, without notarization.
  - Create or import that identity on each build Mac first.
  - Close the running app before packaging.
  - This is not a Developer ID release.
  - The first signed update can need new Keychain and privacy permissions.
  - The build packages local engine installers. It does not download or bundle the Whisper, llama.cpp or sherpa-onnx engines.
- `pnpm run update:local` builds the local production app, installs it and starts the installed version. Quit Gristmill first. Details: [scripts](scripts.md#local-update).
  - For verification, use `--target /temporary/Gristmill.app --user-data-dir /temporary/profile`.
  - To install an already built bundle without a start, use `node scripts/install-macos-local.cts`.
  - Never keep renamed `.app` backups such as `previous.app`. macOS can track them in permission lists.
  - The installer refuses a running app. It does not reset privacy permissions.

## Command maintenance

- [package.json](../../package.json) and [run-tests.cts](../../scripts/run-tests.cts) define the executable behavior.
- When their public behavior changes, update this document in the same change.
- When you edit the runner, confirm both a successful selection and a non-zero exit for an invalid selection.
- Keep the documentation examples executable with installed dependencies.
- Tooling sources, consumers and runtime limits: [script inventory](scripts.md).
