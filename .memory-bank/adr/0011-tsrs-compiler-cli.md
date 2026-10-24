# ADR-0011: Use tsrs as the TypeScript compiler CLI

Status: Accepted. Supersedes ADR-0005 for the compiler CLI.
Date: 2026-10-21
Decided by: Timur Khakhalev; pull request "Switch the TypeScript compiler CLI to tsrs"

## Context

ADR-0005 selected native TypeScript 7 (`tsc`, package `@typescript/native`) for typecheck and `build:main`.
`tsrs` is a Rust port of the TypeScript 7 compiler. It follows upstream TypeScript and accepts the same `tsc` options.
On this repository, `tsrs` gave the same file graph, the same diagnostics and byte-identical `build:main` output as TypeScript 7.0, and it was approximately 5 times faster.

## Decision

- All `typecheck:*` scripts, `build:main` and `build:companion` run `tsrs` (package `tsrs`) with the same arguments that `tsc` used.
- Pin `tsrs` to an exact version. It is a pre-1.0 release, and each version follows a specific TypeScript 7.1 development build.
- The Compiler API part of ADR-0005 does not change: the `typescript` package stays an alias for TypeScript 6 for type-probe tests and the Oxlint tooling.

## Alternatives considered

- Keep TypeScript 7.0 `tsc`. It is the stable upstream release, but it is the slowest option.
- Use TypeScript 7.1 beta `tsc`. It was approximately 1.3 times faster than 7.0 on this repository; `tsrs` was approximately 4 times faster than 7.1 beta.

## Consequences

- `tsrs` returns exit code 2 for diagnostics; `tsc` returns 1. Scripts must treat every nonzero code as a failure.
- `tsrs` supplies binaries only for macOS arm64 and Linux (x64 and arm64). There is no macOS x64 or Windows binary.
- Diagnostic order can be different from upstream `tsc`. Do not compare compiler output by line order.
- To return to upstream TypeScript 7, add `@typescript/native` again and change `tsrs` back to `tsc` in `package.json`, `scripts/build-main.cts` and `scripts/build-companion.cts`.
- Commands: [project commands](../steerings/project-commands.md).
