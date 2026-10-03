# ADR-0006: Canonical test runner with a two-process limit

Status: Accepted
Date: 2026-09-27
Decided by: Timur; issues #93, #94, #95

## Context

A full run in one process was slow.
Parallel agents started tests and builds at the same time and overloaded the machine.
The native SQLite ABI changed between Electron and Node.

## Decision

- `pnpm test` is the only entry point.
- Ordinary test files run in a maximum of two isolated processes.
- Compiler, native and shared-resource files run in a separate phase with one worker.
- SQLite preparation and `build:main` run one time for each run.
- A full run takes a lock in the common Git directory. The lock applies across worktrees.
- On macOS, tests run in Electron Node mode. They share the SQLite ABI with `pnpm dev`. Linux CI uses Node.
- Only the root orchestrator runs tests, builds and installs. It runs them in sequence.

## Consequences

- Check selection policy: [quality](../steerings/quality.md).
