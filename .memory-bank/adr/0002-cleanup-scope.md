# ADR-0002: Product boundary after the cleanup

Status: Accepted
Date: 2026-09-14 (cleanup merged in pull request #6)
Decided by: Timur

## Context

The OpenWhispr import ([ADR-0001](0001-openwhispr-one-time-import.md)) brought accounts, a cloud service, dictation, team features and enterprise policies.
Gristmill is a personal local tool for meetings.

## Decision

Remove these surfaces:

- OpenWhispr Cloud and the server product layer.
- Dictation and the standalone assistant.
- Home and Insights.
- `web_search`, YouTube import, Qdrant and semantic search.
- Upstream updates and all distribution that is not macOS arm64.

Keep these surfaces:

- Notes as the product root.
- The full embedded chat.
- All BYOK, Local and Self-Hosted routes.
- Realtime recording and all speaker recognition.
- Dictionary and Snippets, calendars and import.

The start view is Home. Do not add a dashboard that replaces Notes as the product root.
The full list is in [product scope](../product/scope.md).

Timur confirmed these details:

- "Remove Cloud" means only OpenWhispr Cloud. Direct provider requests with the user's keys stay.
- Dictionary and Snippets keep their data, their chat tools and their management screen. Only the dictation use is removed.
- The removal of the standalone ChatView and voice assistant does not remove tools from the embedded Note chat.
- Do not remove code only because it contains the word `cloud`, `auth` or `policy`. Provider authorization, calendar OAuth and capture rules have their own uses.

## Consequences

- To bring back a removed surface, make a new product decision (a new ADR).
- Run smoke tests only on isolated Gristmill profiles. Never use the original OpenWhispr profile.

## Amendment 2026-10-03

The removed Home was the OpenWhispr dictation history. The current Home is a different start view
(upcoming calendar events, recent notes across spaces and a cross-note chat). It does not replace
the Note as the product root. Only the sentence about the start view changed; the removed surfaces
above still hold.
