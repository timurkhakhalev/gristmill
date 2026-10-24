# Script inventory and execution

Use Node 24 or later and pnpm 10.19.0 from the repository root.
The toolchain decisions are [ADR-0005](../adr/0005-typescript-toolchain.md) and [ADR-0011](../adr/0011-tsrs-compiler-cli.md).

## TypeScript tooling rules

- Supported Node tooling is strict TypeScript.
- `pnpm run typecheck:scripts` examines its own program. `pnpm run lint` includes it.
- A dependency-free `.cts` script needs no loader and no installed package. Node removes its types.
- CommonJS (`require`, `__dirname`, `require.main`) is intentional for these tools and for the electron-builder hooks. Keep their syntax erasable by Node.
- Provider canaries are `.mts` files. They use `node --import tsx` because their application imports need TypeScript module resolution and transformation.
- Canaries run only in the explicitly dispatched CI workflows, with supplied provider credentials.
- Migrated JS, CJS and MJS sources have no legacy copies and no extension shims. Do not add them.

## Generated runtime tools

- `build:main` runs `build:runtime-tools` after the main and preload compilation.
- `build:runtime-tools` bundles the three engine downloaders and the Notes CLI into standalone CJS in `resources/local-engine-installers/` and `resources/cli/`.
- These are generated, ignored outputs. Do not edit or maintain copies of them.
- The installed application needs neither TypeScript nor tsx.
- Development also uses the generated CLI. Source engine installers can run in Electron Node mode.
- Packaging copies the generated tools as extra resources.
- An install alone runs only `electron-builder install-app-deps`. It does not need compiled scripts.

## Local update

```sh
pnpm run update:local
```

1. Save active and paused recordings.
2. Quit Gristmill.
3. Run the command.

The command does these steps:

1. It makes sure that the permanent destination is stopped.
2. It builds `build:mac:arm64:local` with the configured `Gristmill Local Signing` certificate.
3. It installs the app at `/Applications/Gristmill.app`.
4. It starts that bundle with Launch Services.

- The installer examines running processes and signatures again.
- It stages without an `.app` suffix. It validates the ZIP backup and the new bundle.
- If the replacement or the registration fails, it restores the previous bundle.
- The previous version stays in `/Applications/.gristmill-backup.zip`.
- It does not reset privacy permissions and does not change user settings.
- Use the same certificate for all local updates.
- This local signature is not a notarized Developer ID release.

At the first `codesign` request for the signing key, enter the login keychain password and select **Always Allow**.
**Allow** applies to one operation. Then a prompt can occur for each embedded binary.
This is different from the permission of the installed app to read its stored credentials.

To install an already built bundle without a start:

```sh
node scripts/install-macos-local.cts [path/to/Gristmill.app]
```

To test the full update command, use an isolated destination and an isolated profile. Do this only with explicit authorization:

```sh
pnpm run update:local --target /tmp/gristmill-update/Gristmill.app --user-data-dir /tmp/gristmill-update/profile
```

- Create the parent directory of the destination first.
- A custom destination needs `--user-data-dir`.
- Ordinary verification does not authorize a replacement of the real installed application.
- An update failure exits with a non-zero code. A build or install failure never starts an app.
- A start failure keeps the newly installed, validated bundle and its backup.

## Supported sources and consumers

| Sources under `scripts/`                                                                                      | Consumers and purpose                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build-native.cts`, `lib/build-macos-swift-binary.cts`                                                        | `compile:native` and five focused `compile:*` commands. Swift helpers, the calendar disclaim executable, Mach-O architecture and hash validation. The audio tap keeps the macOS 14.2 target. Other helpers keep 11.0. Cached helpers go back to the loop. They do not stop it. |
| `compile-macos-icon.cts`                                                                                      | `compile:mac-icon`, macOS prebuild. Optional Xcode `actool`. Uses the existing `.icns` when `actool` is not available.                                                                                                                                                         |
| `build-main.cts`                                                                                              | `build:main`, dev and start, tests that need emitted code, packaging. Main TypeScript graph, sandboxed preload bundle, runtime CJS tools.                                                                                                                                      |
| `build-companion.cts`                                                                                         | `build:companion`, packaging. Production and development browser extension identities and bundles.                                                                                                                                                                             |
| `build-runtime-tools.cts`                                                                                     | `build:main`, direct `build:runtime-tools`. Generated CLI and local-engine installers.                                                                                                                                                                                         |
| `beforeBuild.cts`, `afterPack.cts`                                                                            | electron-builder production and Dev hooks. Forced Electron ABI rebuild, packaged SQLite, FFmpeg and worker checks, ONNX binary pruning, native signing registration. Node 24 loads them directly.                                                                              |
| `check-dev-app-build-target.cts`                                                                              | `pack:dev`. Rejects a rebuild of a running output bundle.                                                                                                                                                                                                                      |
| `run-electron.cts`, `launch-macos-electron.cts`, `dev-electron-bundle.cts`                                    | `start`, `dev:main`. ABI check, environment cleanup, Launch Services attribution, cached Dev identity and icons.                                                                                                                                                               |
| `ensure-sqlite-runtime.cts`                                                                                   | App launcher, canonical test runner, direct diagnostic. Repairs only a confirmed ABI mismatch.                                                                                                                                                                                 |
| `run-tests.cts`, `test-selection.cts`                                                                         | `pnpm test`. Selection and classification, full-run lock, two-process ordinary phases, serial native and compiler phases, process-group cleanup.                                                                                                                               |
| `mutation.mts`, `mutation-targets.mts`, `mutation-cloud/`                                                                   | `pnpm mutation` and the manual Cloud Run image. Explicit target allowlist, one bounded Stryker target per run, timeout, metadata and execution-specific report uploads. See [mutation testing](mutation-testing.md).                                                           |
| `install-macos-local.cts`, `update-local.cts`                                                                 | Direct install, `update:local`. Stable-path installation, backup and rollback, start.                                                                                                                                                                                          |
| `gristmill-cli.cts`                                                                                           | Generated Notes CLI. Read-only profile discovery, private connection, filters, human and JSON output.                                                                                                                                                                          |
| `download-whisper-cpp.cts`, `download-llama-server.cts`, `download-sherpa-onnx.cts`, `lib/download-utils.cts` | `download:*` commands and engine installation that the application starts. Pinned releases, install markers, archive and library handling. These are not bundled engine binaries.                                                                                              |
| `download-diarization-models.cts`, `download-whisper-vad-model.cts`                                           | Explicit `download:*` commands. Developer asset preparation and offline-cache tests.                                                                                                                                                                                           |
| `check-i18n.cts`                                                                                              | `i18n:check`, PR CI. Locale keys, placeholders and plural forms.                                                                                                                                                                                                               |
| `sync-nucleo-icons.cts`                                                                                       | Manual regeneration from the local licensed Nucleo catalog. The generated icon barrel names it as the source. It does not run during install or build.                                                                                                                         |
| `llm-canary.mts`                                                                                              | Its `workflow_dispatch` CI workflow and credential-free regression tests. Live APIs need separately supplied credentials.                                                                                                                                                      |
| `complete-uninstall.sh`                                                                                       | Interactive manual macOS removal script, with a source scope check. It stays in Bash for its shell prompts and its sudo, process and removal commands. Never use it in an update or in automated verification.                                                                 |
