# Security policy

## Report a vulnerability

Do not open a public issue for a security vulnerability.
Use [GitHub private vulnerability reporting](https://github.com/timurkhakhalev/gristmill/security/advisories/new) for this repository.

Gristmill is a personal project. Only the latest version on `main` gets fixes.

## Scope

In scope:

- Remote code execution through crafted audio files, provider responses or transcription output.
- Exposure of credentials (API keys, OAuth tokens) or of private recordings, transcripts and notes.
- Insecure IPC between the main process and the renderer.
- Insecure local bridges: the Notes CLI bridge, the BB bridge and the Companion native host socket.
- Privilege escalation through native helpers.
- Supply-chain attacks through dependencies or native compilation.

Out of scope:

- Problems that need physical access to a machine that is already unlocked.
- Denial of service against the local application.
- Social engineering.

## Security model

- **Local data.** Gristmill has no backend. Recordings, transcripts and notes stay in the local profile. Audio goes to a provider only when the user selects a cloud or Self-Hosted route.
- **Credentials.** The macOS Keychain keeps a master key. Each secret is encrypted with AES-256-GCM under `userData/secure-keys/`. If the Keychain is not available, Electron `safeStorage` encrypts the secrets. If no backend is available, secret reads and writes fail closed.
- **Renderer isolation.** Renderer windows use context isolation without Node integration. The renderer gets only a narrow typed preload bridge. It does not get arbitrary file paths.
- **Local bridges.** The CLI and BB bridges use loopback connections with profile-local, owner-only token files. The CLI token is read-only. The Companion native host authenticates to a profile socket with a private credential. The extension never gets this credential.
- **Native helpers.** The build compiles the Swift helpers from source.

Details: [BB integration](.memory-bank/architecture/bb-integration.md), [Companion](.memory-bank/architecture/companion.md).
