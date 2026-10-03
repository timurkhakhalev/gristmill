# ADR-0005: Native TypeScript 7 and TypeScript 6 for the Compiler API

Status: Accepted
Decided by: Timur; issue [#10](https://github.com/timurkhakhalev/gristmill/issues/10) and the subsequent migration stages

## Context

The imported code was JavaScript.
We changed it to strict TypeScript in stages: typed IPC boundaries, provider selectors, storage and native adapters.

## Decision

- `typecheck` and `build:main` use native TypeScript 7 (`tsc`, package `@typescript/native`).
- The `typescript` package is an alias for TypeScript 6 (`tsc6`). Use it only for Compiler API consumers: type-probe tests and `typescript-eslint`. TypeScript 7.0 does not supply a programmatic API.
- Keep the CLI package and the API package separate until TypeScript 7 supplies an API.
- Node tooling is strict TypeScript. Use `.cts` for native Node CommonJS (Node 24 removes the types). Use `.mts` with `tsx` for provider canaries.
- Migrated JS, CJS and MJS sources have no legacy copies and no extension shims.

## Consequences

- Typecheck targets and commands: [project commands](../steerings/project-commands.md).
- Script inventory: [scripts](../steerings/scripts.md).
