# Documentation

## Where to put knowledge

| Knowledge                                                | Location                                |
| -------------------------------------------------------- | --------------------------------------- |
| Durable product, architecture and process knowledge      | `.memory-bank/`, in the related section |
| The reason for a significant decision                    | A new ADR in `.memory-bank/adr/`        |
| Task draft, plan, progress, reviews                      | `.tasks/<task>/` (temporary)            |
| Open work, backlog, evaluation checklists                | GitHub issues                           |
| Test logs, measurements of one run, verification reports | The pull request description            |

## Rules

- Update the related document in the same change as the behavior.
- If a document caused an agent error, correct the document and the code.
- When you add a document, add a line for it to the index of its section.
- Do not change an accepted ADR after the decision. Write a new ADR that supersedes it.
- Do not refer to `.tasks/` from permanent documents.
- Keep only knowledge that helps a future change. Do not keep task status, one-time migrations, session logs or historical measurements.
- Do not copy what the code shows clearly. Describe boundaries, contracts, invariants and reasons.
- Write documentation in English. Use ASD-STE100 Simplified Technical English.
