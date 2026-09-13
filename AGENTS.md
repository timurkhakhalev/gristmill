# OpenHercules working rules

Read `README.md` and the documents under `docs/` before making architectural or product changes.

## Invariants

- The original microphone and system tracks are the source of truth.
- Capture must not depend on network access or a model provider.
- Never silently fall back from dual-track capture to an apparently complete mic-only meeting.
- Do not delete or overwrite raw audio or previous processing artifacts during retry.
- Keep provider-specific payloads behind canonical stage contracts.
- Persist long-running processing state so it can resume after restart.
- Keep the first product macOS-only and meeting-only unless the scope is explicitly changed.
- Prefer a static TypeScript provider registry over a plugin framework until dynamic plugins are required.
- Do not preserve old OpenWhispr product paths through compatibility shims after cutover.

## Scope discipline

Do not reintroduce dictation, a general voice assistant, team collaboration, hosted sync, enterprise controls, or cross-platform support without an explicit product decision.

When importing OpenWhispr code, preserve its MIT license and attribution. Import only the code and assets needed by the documented product surface.

