# Dictionary and Snippets

As a Gristmill user, I want to teach Gristmill my special words and keep reusable text.

## Entry points

- **Gristmill app → Settings → Dictionary → Dictionary tab** — words for transcription.
- **Gristmill app → Settings → Dictionary → Snippets tab** — saved text with a trigger phrase.
- **Gristmill app → Chat** — ask the chat to read or change the Dictionary and Snippets.

## Paths

### Add words to the Dictionary

1. Open Settings → Dictionary.
2. Type words in the field, separated by commas, for example `Gristmill, Supabase, John Snow`.
3. Press Enter or click **Add**. The words appear in **Your dictionary**.
4. Gristmill sends these words to the transcription provider as hints.
5. If the list becomes long, Gristmill shows a notice. Some models read only the end of a long list.

### Import or export a word list

1. Click **Import words**. Paste the words, one on each line or separated by commas.
2. Gristmill shows how many words are ready. Click **Import**. Gristmill removes empty values and duplicates.
3. To save the list, click **Export dictionary** and select a location for `dictionary.txt`.
4. You can import the exported file again. Words with commas, quotes or line breaks stay correct.

### Edit or remove words

1. Type in the field to search the list.
2. Click a word to edit it, or click its remove button.
3. To remove all words, click **Clear all** and confirm. The agent name entry (**Added by default**) stays.

### Make a snippet

1. Open the **Snippets** tab and click **New snippet**.
2. Type a **Trigger**, for example `cal link`, and the **Replacement** text.
3. Click **Create snippet**. A trigger must be unique. Case does not matter.
4. To change a snippet, click it and edit it. To delete it, click its remove button.

### Use snippets and the Dictionary from the chat

1. In the chat, ask for the text of a snippet, for example "insert my cal link".
2. The chat reads the exact saved text.
3. Ask the chat to add or remove Dictionary words, or to create, replace or delete a snippet.
4. Snippets work only inside Gristmill. They do not expand text in other apps.

## BDD acceptance criteria

- Given a word contains a comma or a quote, when I export and import it, then the word stays the same.
- Given I click **Clear all** and confirm, when the list clears, then the agent name entry stays.
- Given a snippet trigger exists, when the chat updates it, then its replacement text changes.

## Related documents

- [Vocabulary architecture](../../architecture/vocabulary.md) — import format, limits and prompt budgets.
- [AI conversations](chat.md) — chat tools.
