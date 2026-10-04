# ADR-0007: Explicit Tinfoil catalog effects

Status: Accepted, 2026-10-04

## Context

Transport acquisition triggered a background catalog refresh, including on client
cache hits. That refresh could repair settings. Awaiting a client did not await
refresh, so reading model metadata after setup depended on timing.

## Decision

Keep the existing catalog owner. Invoke refresh and reconciliation explicitly from
the language picker and the two renderer inference entrypoints. Apply fresh cached
metadata synchronously and shape each request before asynchronous SDK setup. Keep
network refresh in the background and selection repair for later operations.

## Consequences

Client construction has no settings effects. Requests retain their selected model
and parameters while the catalog changes. Offline retirement repair and persisted
meeting snapshots retain their separate semantics. No scheduler or new store is
needed. See [catalog contract](../architecture/tinfoil-catalog.md).
