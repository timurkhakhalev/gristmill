# ADR-0001: OpenWhispr is a one-time code source

Status: Accepted
Date: 2026-09-14
Decided by: Timur

## Context

Gristmill needs a Granola-like interface, macOS capture, calendars and provider adapters.
OpenWhispr (MIT license) has all of these.
But OpenWhispr is a cross-platform product with dictation, a cloud service and team features.

## Decision

- Import OpenWhispr one time from commit `4335972b96a62caab0c822b3b9549a1a4fdbb351` (upstream date 2026-09-11).
- The baseline commit in this repository is `49cd2b3`. The provenance is in [docs/openwhispr-upstream/IMPORT.md](../../docs/openwhispr-upstream/IMPORT.md).
- Do not merge upstream continuously. Use the `upstream` Git remote only to review specific macOS fixes.
- Keep the MIT license (`LICENSE`) and the attribution.
- Import only the code and assets that the documented product surface needs.
- After the cutover, do not keep legacy directories, commented-out code or compatibility shims for old OpenWhispr paths.

## Alternatives considered

- A long-lived rebranded fork with regular merges. We rejected it. It brings back removed products and conflicts with the record-then-process architecture.

## Consequences

- To restore a removed feature, use commit `49cd2b3`. Do not use runtime flags.
- The app was renamed later (OpenHercules → Gristmill, bundle ID `com.khakhalev.gristmill`). The code does not read old `openwhispr` or `openhercules` paths and variables. Do not add them.
- The original upstream README and documents are in `docs/openwhispr-upstream/` for reference only. They do not describe Gristmill.
