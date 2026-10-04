# Renderer import boundary

The renderer calls main through `window.electronAPI` and shared IPC contracts. It must not load Node, Electron or main implementation modules.

## Direct imports

The renderer ESLint configuration enforces the boundary for root renderer source files and `components`, `hooks`, `stores`, `services`, `models` and `lib`. The main-only `services/localReasoningBridge.ts` is excluded. Main helpers, preload and ONNX workers retain their own runtime requirements.

`no-restricted-imports` rejects Node built-ins, Electron, preload, workers and unapproved helper imports. It also rejects the main-only process/server utilities, Local reasoning bridge and root main/preload entries. The rule applies to static imports, re-exports and type imports, including `@/` paths. Shared types belong in contracts rather than main implementation.

`helpers` contains both browser and main code. Its permitted renderer entries are listed once in `src/eslint.config.js`. For example, `transcriptionRoute` and `chatRouting` are permitted; `database` and `ipcHandlers` are not. Before adding an entry, trace its runtime dependencies. A directory name alone does not prove browser safety.

Literal dynamic imports use the same restrictions through `no-restricted-syntax`. Node globals such as `process`, `Buffer` and `require` are rejected. Arbitrary computed dynamic paths are outside this syntactic guarantee.

## Selected shared graph

The regression tests resolve the project-local runtime graph rooted at settings selectors and transcription/chat routing. They lint each reached source file with the same boundary policy. Re-exports and literal dynamic imports participate in graph resolution. A negative probe injects a Node re-export into a transitive dependency without changing the repository source.

This graph check has explicit limits: third-party packages stay external, and type-only dependencies and arbitrary computed imports do not become runtime graph edges. Direct rules still check type imports in files that are covered. This is not a claim that every shared helper or the whole renderer graph is pure.

## Verification

- `pnpm run lint` runs the direct rules through the normal renderer configuration.
- `test/cases/platform/unit/rendererImports.test.ts` verifies allowed shared imports, forbidden Node/main imports in each scope, aliases, re-exports, literal dynamic imports, Node globals and the selected transitive graph. It rejects ignored-file results as coverage failures.
- Renderer typecheck and build verify the application consumers. Main/preload graph and shared-helper probes verify the other runtime.

The all-src renderer compiler and Vite external list remain unchanged. Neither provides this import boundary by itself. This pilot adds no dependency checker and does not move shared helpers.
