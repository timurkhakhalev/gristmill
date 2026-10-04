# Tinfoil catalog and request snapshots

The renderer catalog owner is `models/tinfoilModels.ts`.
`refreshTinfoilCatalogAndReconcileSelections()` applies a fresh persisted catalog
synchronously. With an expired cache it shares one fetch promise in the window.
A successful nonempty fetch updates the registry and persisted cache, then repairs
missing Tinfoil model IDs in the three saved inference scopes. It emits one notice
per retired ID in that reconciliation. Failed and empty fetches preserve selections.
The main catalog helper owns attested fetch, cross-window request dedup and failure
cooldown. Renderer cache TTL is one hour; cache writes are best effort.

The shared language CloudTab includes Tinfoil even if another provider is selected.
Its hook awaits the explicit operation and updates its list. Single-shot and SDK
streaming requests start the same operation in the background after key validation.
They apply a fresh cache before shaping the request and capture model capabilities
and parameters before asynchronous SDK setup. Network completion cannot change
those parameters or retarget that operation. Retries reuse the shaped request.
A later operation that resolves settings can see a replacement model.

Client acquisition only creates and caches transports. It does not fetch catalog,
repair settings or emit notices. Offline startup repair remains a separate,
one-time policy based on known retired IDs. Main meeting processing uses persisted
model snapshots and does not participate in renderer selection repair.
