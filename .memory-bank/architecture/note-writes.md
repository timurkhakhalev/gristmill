# Note writes

## Editable Notes

`NoteWriteService` owns Note creation and edits from Notes IPC and the BB write bridge. Each transport validates its arguments with the shared Notes schemas. The service validates the database mutation result.

`DatabaseManager` owns SQL and transactions. A successful response means that the database saved the Note. After a successful mutation, the service queues `note-added` or `note-updated`, then requests the Markdown mirror. A failed mutation starts no effects. Event and mirror failures are logged and do not change the saved result.

For a participant edit, the service then refreshes the active capture speaker configuration. The existing count policy applies: a truthy participants value, including `"[]"`, requests a refresh; null and an empty string do not. The coordinator preserves an explicit count and only increases an inferred count.

A change to participants does not assign speaker names, create voice profiles or rewrite transcript speaker labels. Post-Stop processing owns automatic run corrections. It uses voice matches, platform evidence and model proposals, with user corrections first. See [speaker evidence](speaker-evidence.md).

The editor writes only fields the user edited. An approved save acknowledges and clears a field's dirty state only when its current value matches the saved snapshot. Later edits remain pending. The renderer Note store keeps unsaved fields across editor navigation and unmount. One writer per Note drains those fields after a confirmed save. Rejected and failed writes keep the latest fields and show an error with Retry when that Note is open. An open editor adopts external Summary output when no local Summary field remains pending or in flight. This draft retention lasts for the current renderer session; it does not survive an application restart.

Calendar draft materialization carries its saved Note row with the typed handoff across lazy editor mount. If another Note was selected meanwhile, the handoff saves under its original Note owner and leaves the current editor and timer intact. An append that is not cached reads the current saved row before merging. Its completion still belongs to the original Note. Replace handoffs use the carried row without another read.

## Separate write policies

These operations have different ownership and publication rules. They do not use the editable-Note service.

| Operation                                               | Owner and effects                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar Note creation and linking                      | Meeting detection writes the Note and participant metadata. Direct event creation publishes one `note-added` with the linked row. Join notification creation can publish `note-added` followed by `note-updated`. After metadata commits, the engine requests the enabled Markdown mirror through the main owner. These paths do not invoke participant-edit callbacks. |
| Processing selection, speaker corrections and artifacts | The worker owns run artifacts, selected-run history, correction revisions and guarded Note projections. After a guarded projection succeeds, its callback publishes `note-updated` and requests the enabled Markdown mirror. It does not invoke participant-edit callbacks.                                                                                             |
| Manual speaker profile management                       | Speaker IPC owns mappings and profile promotion from saved Note embeddings. Its separate propagation operations keep their own policy. General Note edits do not invoke the old one-on-one propagation operation.                                                                                                                                                       |
| Folder membership operations                  | Container handlers own their transactions, container events and mirror refreshes. Individual Note edits through UI and BB use the shared Note service.                                                                                                                                                                                                                  |
| Note deletion                                           | The dedicated deletion operation owns the durable intent, work barriers, files, database rows, `note-deleted` and mirror cleanup. It is not a general Note update.                                                                                                                                                                                                      |

Calendar and worker writes keep their own transactions and event ordering. They share only the main-owned mirror queue: it re-reads the current Note after commit, skips deleted Notes and rechecks enabled state before writing. Projection failures do not roll back saved data. An empty persisted transcript removes its prior transcript mirror. The mirror contains the current Note projection, not raw responses or run history.
