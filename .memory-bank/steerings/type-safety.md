# External data and unknown

`unknown` is acceptable when a value is genuinely unknown: HTTP or webhook input, JSON parsing, untrusted storage reads, error handling, and generic transport or parser interfaces. Before using a value as a domain object, validate it with an existing runtime schema or a complete parser. Business logic receives a validated, concrete type.

When creating or changing such a boundary:

- Identify where the data comes from, where it is validated, and which type is passed onward. Do not replace an honest `unknown` with `as DomainType`, an invented generic, or `JsonValue` to pass lint.
- If an unknown restriction prevents an honest parser contract, add or update an exact-file override for that specific rule. Explain the reason next to the setting using a comment in a supported config format. Do not disable rules for all adapters or routes. Update or remove the exception when moving or deleting the parser.
- Allowing unknown input does not allow unknown output. For a generic transport that genuinely returns an opaque value, justify the return exception separately and identify the caller's parser before the business operation.
- For a new or changed external handler, verify that invalid data is rejected before a business operation or side effect and valid data reaches it. Follow the project's existing testing approach and use fake collaborators.

A function's responsibility and data flow determine whether it is a boundary. Lint and the import graph do not establish this automatically. Verify the truth of a type predicate and the completeness of a parser through implementation review and tests.

## Scope: tests are not linted

Oxlint and Oxfmt exclude `test/**`. Owner decision from 2026-10-06, tracked in #278 with the deferred test stage in #301.

- `test/**` is out of the lint and format scope. Do not fix test style, assertions, `require`/loader typing or test-only types to satisfy a lint rule.
- Tests still run and still pass `pnpm run typecheck:tests`. Those checks are not optional.
- Change a test only for the behavior, contract or consumer it covers. Pick checks for that behavior, not for lint.
- An excluded file proves nothing. A clean lint result on an ignored path is a skip, not a passing control; the consumer probes check this explicitly.
- When a rule change would affect how tests are written, verify the source rule in a linted source path instead of adding a test-only exception.
