# Correct speakers

As a Gristmill user, I want to give transcript speakers the right names.

## User journey

1. Open the selected result transcript and click a speaker name.
2. Edit the display name and optionally choose an existing voice profile.
3. Choose Only this meeting, or link the name to an available calendar participant email.
4. Save the correction. Review the stale Summary notice and regenerate or dismiss it.

## Behavior and limits

- The dialog defaults to Only this meeting each time it opens; it does not restore a previously linked email as the initial selection.
- Participants come from the note. A participant is a candidate, not proof of speaker identity. Only an email belonging to the note participants can be linked.
- A linked contact name is remembered locally; this does not edit Google contacts.
- Choosing a voice profile in Results stores its ID in the correction. It does not create a profile or train a voice embedding.
- Name evidence priority is user, voice, platform, then model. Weaker automatic evidence does not replace a manual name.
- Corrections change the displayed transcript mapping, not raw provider output. They do not rewrite an existing Summary.
- Summary staleness follows the correction revision. Dismiss applies to that run/revision; a later correction can show the notice again.
- For multiple recording groups, the combined transcript does not offer clickable speaker correction. Open the selected result transcript to edit names.
- Model names have an auto badge; platform names show their source. A user correction replaces this provenance.

## What to check

- Manual names remain after automatic suggestions.
- A new correction marks the existing Summary stale.
- A linked participant is from the current note.

## BDD acceptance criteria

- Given a speaker has a user correction, when weaker automatic evidence arrives, then the user name remains.
- Given I dismiss a stale Summary notice, when I make another correction, then the new revision can show the notice again.

## Entry points

- [MeetingResultsPanel.tsx](../../../src/components/notes/MeetingResultsPanel.tsx) — correction dialog and stale notice.
- [meetingProcessing.ts](../../../src/helpers/meetingProcessing.ts) — correction validation.
- [database.ts](../../../src/helpers/database.ts) — evidence priority and revisions.
- [speakerIpcHandlers.ts](../../../src/helpers/speakerIpcHandlers.ts) — separate voice-profile operations.
