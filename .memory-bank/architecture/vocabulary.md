# Dictionary and Snippets

This document contains the format, limit and tool rules of the Dictionary and Snippets.
User paths: [Dictionary and Snippets](../product/user-journeys/dictionary-snippets.md).

## Dictionary

- Import accepts commas and line breaks. It trims entries and ignores empty values and case-insensitive duplicates.
- Quoted exported entries support commas, quotes and line breaks.
- Export opens a save dialog for `dictionary.txt`. It includes the stored agent-name entry, although the UI shows that entry separately.
- Clear all requires confirmation and keeps the agent-name entry.
- The persistence path has no record-count cap. The UI warns above 550 characters of words plus snippet triggers. Provider prompt budgets are separate limits.

## Snippets

- A snippet stores a nonempty trigger and replacement. Triggers are unique without case.
- The UI trigger limit is 80 characters. Storage and chat tools allow 100.
- Snippets have no bulk import or export control. The inspected path enforces no count or replacement-length cap.

## Vocabulary hints

- Words and snippet triggers become vocabulary hints. Replacement text is not part of the hint list.

## Chat tools

- `get_snippet` reads exact snippet text. `update_snippets` creates, replaces or deletes snippets. `update_dictionary` adds or removes words.
- Availability depends on the route and the registered tools. BB uses its own allowlist; see [BB integration](bb-integration.md).
- Snippets do not give global text expansion in external apps.

## Code locations

- `src/components/DictionaryView.tsx`, `src/components/SnippetsView.tsx` — UI.
- `src/helpers/dictionaryImport.ts` — import and export format.
- `src/helpers/transcriptionDataIpcHandlers.ts` — export file.
- `src/utils/dictionaryPromptCap.ts` — prompt budgets.
- `src/services/tools/snippetTool.ts`, `src/services/tools/dictionaryTool.ts` — chat tools.
