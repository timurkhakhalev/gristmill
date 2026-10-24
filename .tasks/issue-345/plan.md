# Fix local model list validation

Downloaded LLMs appear unavailable because the preload validates two array responses as records. Fixes #345.

1. Add bridge regressions for model and active-download lists.
2. Define concrete row schemas in the shared contract and parse both list responses in preload.
3. Log catalog and download-restoration failures.
4. Check model selection, settings reconciliation, all download types, malformed responses and catalog compatibility.
5. Run focused regressions, platform graph checks, lint, typechecks and isolated runtime verification.

Keep the current wire fields and optionality. Reject malformed lists as a whole; never turn a failed response into an authoritative empty catalog for settings reconciliation. Keep changes limited to these two responses and their consumers.

## Result

Implemented concrete array parsing and failure logging. Regression tests cover the bundled preload, the full shipped catalog, real tracker snapshots, real manager output, renderer inventory and settings reconciliation. A synthetic smoke check passed in a sandboxed Electron window with a temporary profile. Full application navigation, real model inference and release packaging were not checked. See the pull request for verification commands and results.
