# Troubleshooting

This runbook contains only verified, Gristmill-specific steps.
Do not debug with the production profile or the original OpenWhispr profile.
If possible, reproduce the problem with a new explicit `--user-data-dir`.

## Logs and debug mode

- Capture errors go to `userData/logs/capture-errors.log` without Debug mode. There is one rotated file, `capture-errors.1.log`. Each file is 1 MiB or less.
- To open the logs folder, use Settings → Developer.
- For a detailed log, enable Debug mode, or set `GRISTMILL_LOG_LEVEL=debug` (`LOG_LEVEL` also works). Then reproduce the problem.
- The profile is `~/Library/Application Support/Gristmill`. The Dev profile is `Gristmill-development`.

## The microphone or the system audio is missing

1. Open System Settings → Privacy & Security.
2. Make sure that Gristmill has the Microphone permission and the system audio permission.
3. After a new local signature, the application can need new permissions. Remove old entries for renamed bundles manually.

A missing system track shows as degraded or incomplete capture.
Gristmill never records a mic-only meeting as complete.
For device recovery behavior, see [post-Stop processing](../architecture/post-stop-processing.md).

## The app or the tests show a native SQLite error

`pnpm dev`, `pnpm start` and `pnpm test` examine the Electron SQLite binding.
They repair an ABI mismatch automatically.
If the error continues:

1. Stop all running apps and tests.
2. Run `pnpm install --frozen-lockfile` in the same worktree. Do not run other commands at the same time.

See [local builds](local-builds.md#native-sqlite-abi).

## The local transcription engine is not found

The app bundle does not include Whisper, llama.cpp or sherpa-onnx.
The application installs the engine into `userData` when you first use a downloaded local model.
From source, the `download:*` scripts get pinned releases ([scripts](../steerings/scripts.md)).

## Keychain prompts after an update

A local build uses the persistent `Gristmill Local Signing` identity.
The first change to this identity, or an ad-hoc build, can ask for Keychain access again.
Select **Always Allow**. See [local builds](local-builds.md).

## BB route errors

The version check fails closed. A missing or incorrect `bb` CLI version shows as an error.
There is no fallback route. See [BB integration](../architecture/bb-integration.md#updating-bb).

## Complete removal

`scripts/complete-uninstall.sh` is the interactive manual removal script for macOS.
Never use it in an update or in automated verification.
