# AI Actions

As a Gristmill user, I want to change the instructions that the AI uses for my meeting notes.

## Entry points

- **Gristmill app → sidebar → Actions** — the Custom Actions dialog.

## Paths

### Change a built-in instruction

1. Click **Actions** in the sidebar. The **Custom Actions** dialog opens.
2. Select a built-in action. It shows **Built-in**:
   - **Detailed Notes** — the instruction for the meeting Summary.
   - **Follow-up** — the instruction for **Draft a follow-up** in the note chat.
   - **Recap** — the instruction for a short recap in the Summary.
   - **Generate Notes** and **Follow-up email** are in the list, but no screen uses them now.
3. Edit the **Prompt** and click **Update**.
4. The next Summary, follow-up or recap uses the new prompt. Existing results do not change.
5. You cannot delete a built-in action.

### Add your own action

1. Click **New Action**.
2. Type the name, an optional description and the prompt.
3. Click **Save**. You can edit or delete your own actions later.
4. No screen runs your own actions now. They are saved prompts only.

### Add a recap to a Summary

1. Open a meeting note with a Summary.
2. Open the result actions and click **New recap**, or **Update recap** if the Summary already has one.
3. Gristmill adds a short recap section to the Summary. Your edits in the Summary stay.

## BDD acceptance criteria

- Given I change the Detailed Notes prompt, when I make a new Summary, then the Summary uses the new prompt.
- Given an action is built-in, when I open its menu, then I cannot delete it.

## Related documents

- [Recording and processing](../../architecture/recording-processing.md) — Summary, tasks, Recap and Follow-up.
- [AI conversations](chat.md) — Follow-up in the note chat.
