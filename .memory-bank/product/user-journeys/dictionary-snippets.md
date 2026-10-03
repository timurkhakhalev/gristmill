# Dictionary and Snippets

As a Gristmill user, I want to improve vocabulary and reuse saved text.

## User journey

1. Open Settings → Dictionary and select Dictionary or Snippets.
2. Add, search, edit or delete words or trigger/replacement pairs.
3. For Dictionary, paste a bulk import or export the words to a text file.
4. Use supported chat tools to read or update saved vocabulary and snippets.

## Behavior and limits

- Dictionary import accepts commas and line breaks, trims entries and ignores empty values and case-insensitive duplicates. Quoted exported entries support commas, quotes and line breaks.
- Export opens a save dialog for dictionary.txt. It includes the stored agent-name entry, although that entry is shown separately in the UI.
- Clear all requires confirmation and keeps the agent-name entry.
- There is no record-count cap in the persistence path. The UI warns above 550 characters of words plus snippet triggers; provider prompt budgets are separate limits.
- Snippets store a nonempty trigger and replacement. Triggers are unique without case. The UI trigger limit is 80 characters; storage and chat tools allow 100.
- Snippets has no bulk import/export control. No count or replacement-length cap is enforced by the inspected path.
- Words and snippet triggers contribute vocabulary hints; replacement text is not part of that hint list.
- Chat tools can read exact snippet text and create/replace/delete snippets or update Dictionary. Availability depends on the route and registered tools. This does not provide global text expansion in external apps.

## What to check

- Dictionary export/import preserves punctuation in entries.
- Clear all keeps the agent-name entry.
- Updating an existing snippet trigger replaces its text.

## BDD acceptance criteria

- Given a word contains a comma or quote, when I export and import it, then its text is preserved.
- Given a snippet trigger exists, when a supported tool updates it, then its replacement text changes.

## Entry points

- [DictionaryView.tsx](../../../src/components/DictionaryView.tsx) — Dictionary and tabs.
- [SnippetsView.tsx](../../../src/components/SnippetsView.tsx) — snippet editor.
- [dictionaryImport.ts](../../../src/helpers/dictionaryImport.ts) — import/export format.
- [transcriptionDataIpcHandlers.ts](../../../src/helpers/transcriptionDataIpcHandlers.ts) — export file.
- [dictionaryPromptCap.ts](../../../src/utils/dictionaryPromptCap.ts) — prompt budgets.
- [snippetTool.ts](../../../src/services/tools/snippetTool.ts) — snippet tools.
- [dictionaryTool.ts](../../../src/services/tools/dictionaryTool.ts) — dictionary tools.
