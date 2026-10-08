# Correct speakers

As a Gristmill user, I want to give the transcript speakers their correct names.

## Entry points

- **Gristmill app → open meeting note → Transcript/Audio popover → selected result transcript** — click a speaker name.

## Paths

### Rename a speaker for this meeting

1. Open the transcript of the selected result.
2. Click a speaker name, for example **Speaker 2**. The **Save speaker** dialog opens.
3. Type the correct name in **Speaker name**.
4. Keep **Only this meeting** in **Remember name for calendar participant**.
5. Click **Save speaker**. The transcript shows the new name.

### Link a speaker to a calendar participant

1. Open the **Save speaker** dialog on a meeting note with calendar participants.
2. In **Remember name for calendar participant**, select the participant email.
3. Click **Save speaker**. Gristmill remembers the name for that email on this Mac. It does not change your Google contacts.
4. The next time the dialog opens, it shows **Only this meeting** again.

### Attach a voice profile

1. In the **Save speaker** dialog, select a profile in **Voice profile**, or keep **No profile**.
2. Click **Save speaker**. Gristmill keeps the link to the profile. It does not make a new profile.

### Update the Summary after a correction

1. After a correction, the note shows **Speaker names changed**. The Summary still has the earlier names.
2. Click **Regenerate Summary** to make a new Summary with the new names.
3. Or close the notice. A later correction shows the notice again.

### Keep your names after automatic naming

1. Gristmill can suggest names from the meeting platform (Zoom, Google Meet, Telemost) or from the AI model. A model name has an auto badge. A platform name shows its source.
2. A name that you typed always stays. Automatic suggestions do not replace it.

### Correct a meeting with several recordings

1. The combined transcript of several Start/Stop groups does not let you click speaker names.
2. Select one result and open its transcript. Correct the names there.

## BDD acceptance criteria

- Given I named a speaker, when an automatic suggestion arrives later, then my name stays.
- Given I closed the stale Summary notice, when I make another correction, then the notice can appear again.
- Given I link a participant, when the dialog opens next time, then it shows **Only this meeting**.

## Related documents

- [Speaker evidence](../../architecture/speaker-evidence.md) — name priority and correction rules.
- [Recording results](meeting-results.md) — the results panel.
