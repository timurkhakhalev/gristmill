# TypeScript Quality

Repository-local Oxlint/Oxfmt configuration and executable rules. The root project config inherits `.oxlintrc.json`; local rules use the `quality/` namespace. Framework/import restrictions remain project-local.

The `typescript-quality` skill owns installation and updates. During installation, merge STEERING.md into the project's active steerings. Everyday coding does not require reading this bundle's documentation.

## Verify

Requires Node.js 22.22+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm test
```

The test creates a temporary consumer and checks forbidden syntax, guards and SAFETY assertions, exact-file unknown exceptions, test-file coverage, config inheritance and formatting stability. It does not prove arbitrary guards or comments correct.

Install application tools at the application root. This package.json is only for bundle verification and prevents accidental publication. Keep this directory outside application workspace globs and formatting scans. Update configuration and plugin together and rerun verification.
