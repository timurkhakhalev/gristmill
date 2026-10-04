# ADR-0009: Separate Note and run output scopes

Status: Accepted, 2026-10-04

## Context

Results, CLI and Chat read different forms of Note content. Results can show a run artifact; CLI Summary and Chat tools prefer the saved Note enhancement. The editor also has unsaved content. Current recording selection does not identify the origin of a Note projection, which can be edited manually or retained while a new run is pending.

## Decision

Extend the existing Note read owner with explicit Note and run scopes. Share the worker's saved-artifact resolver and the existing aggregate transcript reader. Provide an internal validated DTO with separate origins, availability, freshness and diagnostics. Use Results and the single-Note Chat tool as consumers. Keep public CLI JSON and batched snippet semantics.

Read persisted metadata to assess freshness. Report unknown origin or freshness when evidence is absent. Keep editor drafts separate and retain all current write guards. Add no storage, schema migration, processing framework or history picker.

## Consequences

Consumers can read a historical run without mutating selection or inventing provenance. Summary-only runs can have distinct Summary and transcript sources. The DTO is larger than a text-only response and adds a persisted read to Results. It does not make every surface share one text or timeline. It does not repair projection publication problems.
