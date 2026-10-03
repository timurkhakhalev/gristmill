# Local automation access

As a Gristmill user, I want to read notes from the terminal and use application-local automation.

## User journey

1. Keep the application running and install the read-only CLI from the packaged app or Advanced settings.
2. Use the [CLI commands](../notes-cli.md) to list, search or read saved notes.
3. Use the embedded BB route for its permitted note and vocabulary tools.
4. Treat the loopback HTTP bridge as an internal integration contract, not a published general-purpose API.

## Behavior and limits

- The bridge starts with the app, binds 127.0.0.1 on a port in 8200–8219 and requires a Bearer token.
- Two tokens are generated at startup. The read connection file is .cli-read-connection.json; the write connection file is .bb-connection.json. Both files use mode 0600.
- The read token permits health and Note list/search/metadata/content/Summary/transcript. It does not grant all GET routes, including folders, vocabulary, models or transcriptions.
- The write route table permits Note create/patch/delete, folder list/create, Dictionary and Snippets list/update, local models and local-file transcription, and separate transcription/audio deletion.
- There are no folder edit/delete routes. /v1/transcribe uses an installed local model and a local file path; it does not run the full meeting/Summary pipeline.
- Embedded BB tools expose a narrower allowlist than the write token: note read/create/patch, folders list/create and vocabulary operations. They do not expose Note delete or transcription/audio routes.
- The CLI remains read-only and does not start transcription or Summary. See its existing document for profiles, output and errors.
- For token discovery and bridge architecture, see [BB integration](../../architecture/bb-integration.md).

## What to check

- CLI operations stay inside the read-token allowlist.
- BB tool availability is not inferred from the full HTTP route table.

## BDD acceptance criteria

- Given a read token, when a write route is requested, then access is rejected as read-only.
- Given a supported CLI read command and a running app, when I execute it, then it reads persisted Note data.

## Entry points

- [cliBridge.ts](../../../src/helpers/cliBridge.ts) — HTTP access and routes.
- [bbWorkspace.ts](../../../src/helpers/bbWorkspace.ts) — write discovery and BB allowlist.
- [installAgentCli.ts](../../../src/helpers/installAgentCli.ts) — CLI launcher.
- [main.ts](../../../main.ts) — bridge startup and packaged CLI installation.
