# Contributing to OpenWhispr

Thanks for your interest in contributing. OpenWhispr is an open-source,
privacy-first voice-to-text app, and improvements from the community —
bug reports, fixes, docs, features — are very welcome.

The canonical contributing guide lives at
**[docs.openwhispr.com/contributing](https://docs.openwhispr.com/contributing)**.
This file is a short pointer with the repo-local details you may need
along the way.

## Filing issues

- Bugs and feature requests:
  [github.com/OpenWhispr/openwhispr/issues](https://github.com/OpenWhispr/openwhispr/issues)
- Please use the existing issue templates (`bug_report`, `feature_request`)
  so we have the info needed to reproduce.
- For transcription or audio problems, attaching debug logs is a huge
  help — see the debug-logging section of
  [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md)
  for how to enable it, where the log files live, and common fixes to try
  first.

## Reporting security issues

**Please do not open public issues for security vulnerabilities.**
Follow the process in [`SECURITY.md`](../SECURITY.md): use
[GitHub's private vulnerability reporting](https://github.com/OpenWhispr/openwhispr/security/advisories/new)
or email `security@openwhispr.com`.

## Contributing code

See the [contributing guide](https://docs.openwhispr.com/contributing)
for the full workflow, coding conventions, and review expectations.
The short version:

1. Fork the repo and create a feature branch off `main`.
2. Make your change, keeping the diff focused.
3. Run `pnpm run lint` and `pnpm run format` before opening a PR.
4. Open a pull request against the project default branch and fill in the
   description so reviewers can see the "why".

### Local setup

| Requirement | Notes                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Node.js     | Version pinned in [`.nvmrc`](../.nvmrc) (currently `24`). Use `nvm use` to match. |
| Install     | `pnpm install --frozen-lockfile`                                                  |
| Run dev     | `pnpm run dev`                                                                    |
| Lint        | `pnpm run lint`                                                                   |
| Format      | `pnpm run format`                                                                 |
| Build       | `pnpm run build:mac:arm64`                                                        |

Platform-specific setup and packaging details are
in [`README.md`](../README.md).

## Thanks

Thanks for taking the time to contribute — every issue, fix, and
improvement helps make OpenWhispr better.
