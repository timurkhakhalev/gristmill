# Invariants

These rules apply to every change. To change a rule, you need an explicit product decision (a new ADR).

## Product scope

- Keep: existing notes (blank notes included), the full embedded chat except `web_search`, all BYOK, Local and supported Self-Hosted routes, realtime recording, all speaker recognition, and the Dictionary and Snippets data, tools and management UI.
- Keep Home (dictation history) and Insights removed. The app opens Notes by default.
- Do not add a replacement dashboard.
- Do not bring back dictation, a general voice assistant, team collaboration, hosted sync, enterprise controls or cross-platform support.
- Do not add compatibility shims. Do not keep old OpenWhispr or OpenHercules paths.
- When you import OpenWhispr code, keep its MIT license and attribution. Import only the code and assets that the documented product surface needs.

Full list: [product scope](../product/scope.md).

## Recording and processing

- The original microphone and system Ogg/Opus tracks (32 kbit/s VBR, complexity 0) are the source of truth. Capture PCM stays in memory.
- Capture must not depend on network access or on a model provider.
- Never change a dual-track capture to a mic-only meeting that looks complete.
- During a retry, do not delete or overwrite raw audio or previous processing artifacts.
- Keep provider-specific payloads behind canonical stage contracts.
- Persist long-running processing state so that it can continue after a restart.
- The product is macOS Apple Silicon only. Keep the existing notes model.
- Use a static TypeScript provider registry, not a plugin framework, until dynamic plugins become necessary.
- Automated tests do not replace live hardware verification.

Reasons: [ADR-0003](../adr/0003-record-then-process.md), [ADR-0004](../adr/0004-opus-capture.md).

## Runtime and data

- For runtime smoke tests, use isolated profiles (`--user-data-dir`). Never use the original OpenWhispr profile or the production profile.
- Update the installed app (`pnpm run update:local`) only when the user asks for it. First quit Gristmill and save active or paused recordings.
- Never rename app backups, reset privacy permissions or delete user settings during an update.
- For verification, use a temporary `--target` together with `--user-data-dir`. See [local builds](../runbooks/local-builds.md).

## Parallel agents

- Subagents can run typecheck and lint. They can write and update tests.
- Only the root orchestrator runs tests, builds, dependency installation and native rebuilds. This includes focused tests, watch mode, lifecycle hooks and equivalent direct commands.
- Subagents report the exact test, build and install commands. They do not run them. Repeat this rule in each delegated task.
- The orchestrator waits until the parallel wave is complete. Then it runs the expensive checks in sequence, never two test, build or install processes at the same time.

Details: [quality steering](quality.md#resource-and-isolation-rules).
