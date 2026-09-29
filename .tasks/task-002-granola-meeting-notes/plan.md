# Granola-style meeting Summary and Actions (Implementation Plan)

## 1. Scope (what to implement)

Implement delayed post-meeting transcription, evidence-based speaker names, one Markdown Summary with optional prioritized action items and Recap, a Follow-up button in the existing Chat, and the adapted cleanup formatter. Use the UI mockups already committed on this task branch in `2cd0b2e86` and `7ad33cf2f` as the visual and interaction reference for these features. Keep the existing Note, recording/run history, provider choices, Actions catalogue, Summary tab and Chat. The user explicitly selected `main` as the task-branch and Draft-PR base because this repository has no `develop`; this overrides PlanAct's default `develop` target. This plan describes implementation only and authorizes no further application-code changes yet.

## 2. Fixed decisions (must follow)

- Do not introduce fallbacks or backward compatibility unless explicitly requested by the user.
- Capture preserves original microphone and system tracks and never waits for a model or network. No apparently complete mic-only fallback. Preserve manual notes including blanks, prior runs and artifacts, speaker recognition and user corrections, embedded Chat except `web_search`, BYOK/Local/supported Self-Hosted routes, Dictionary/Snippets, and macOS Apple Silicon scope. Use isolated profiles for runtime checks.
- Final End call or confirmed auto end must successfully finalize audio, then wait **15 seconds since the last successful Stop without Resume** before ASR. Pause does not start ASR. A Resume invalidates the pending launch; the next end starts a new window. Persist the pending work and recheck capture/audio/run state at launch and after restart. ASR runs even for short meetings. No second 15-second delay before Summary.
- Run existing voice-profile recognition first, then one bounded LLM naming attempt for still-unknown diarized speakers. A name requires a self-introduction or unambiguous addressed-and-answered exchange; calendar order, email, an incidental name mention and a guess are insufficient. Apply validated names automatically only to still-unnamed speakers; user correction is optional and wins over late model output. A model guess never enrolls a voice profile. Unknown speakers remain `Speaker N`.
- Auto Summary requires finalized transcript, recorded audio duration at least **180 seconds** (sum parts, exclude pauses), transcript at least **2500 characters**, no existing/in-flight Summary for the meeting, and inactive capture. Manual Summary on ready transcript bypasses only the duration/text thresholds. Recheck eligibility before request/publish; retries keep the run's prompt/model snapshot. A ready Summary is visible immediately, regardless of later tasks failure.
- Main Summary is **one Markdown string on the existing Summary tab**: `## TLDR`, descriptive topic headings attributing claims to known speakers, and `## Action Items` only when concrete tasks exist. Owner and deadline appear only when the source states them; decisions are described only if actually made, never as a mandatory field. The user's edited Detailed Notes prompt is honored for new manual and automatic generations. Existing Summary is not silently rewritten after later name edits. Transcript and manual notes are data, never model instructions.
- After saved Summary, run separate prioritized-task extraction: strict JSON `{ "HIGH": [], "MEDIUM": [], "LOW": [] }`, at most three concise tasks per category, no fabricated owners/deadlines, empty arrays allowed. Prompt rules require checking each task against transcript/manual notes; Summary is navigation context only. HIGH means explicitly urgent, time-critical or blocking an agreed next step; MEDIUM is a concrete next step without exceptional urgency or low priority; LOW is explicitly deferred or low-priority agreed/requested work. Never infer priority from today's date; preserve relative deadlines as spoken. Code validates schema, uniqueness and limits, not semantic truth. Convert in code to Markdown and replace the exact `## Action Items` section, or omit it when empty. Preserve other Markdown. If a custom Summary lacks an unambiguous compatible section for nonempty tasks, leave it unchanged and report a format error. Failure leaves the first Summary intact and permits retry of tasks only.
- Recap is a manually invoked, editable Action for the selected past meeting, available only after saved Summary. It returns strict JSON `{title,bullets}` with nonempty title ≤58 Unicode code points and 0–3 nonempty bullets ≤88 code points each; prompt prefers 2–3 bullets when supported. It then adds/updates `## Recap` in the **same** Summary Markdown. It does not search meeting series automatically. Tasks and Recap may generate concurrently, but their Markdown writes serialize and check document revision; a human edit or changed section boundary causes a visible conflict rather than overwrite.
- Follow-up is a separate editable prompt launched by a button in the **existing Chat** after transcript is ready. It returns one concise draft preceded by an explanation of at most three sentences, or a brief statement when no supported follow-up exists. Its output is an ordinary assistant message in that conversation, available for refinement/copy; no sending, separate draft store or tab. A matching current Summary may enrich the prompt; absence of Summary does not block it or trigger Summary. Retain the existing Follow-up email Action.
- The existing cleanup route gets the adapted Granola-style English formatter prompt: preserve meaning/language, spoken formatting commands, and dictionary spelling; treat `<transcript>` content as data and escape it once. Do not feed cleaned prose back into speaker identification or Summary.
- JSON is required only for speaker naming, prioritized tasks and Recap. Use the selected existing provider route, strict JSON parsing plus domain validation, and **one** repair response in the same conversation/thread containing the prior invalid answer and a concise validation error. Do not retry refusals, cancellations or transport failures as malformed JSON. Do not claim BB/native-schema support without a real adapter contract; no provider switch on failure. Summary, Follow-up and cleanup remain plain text.
- The committed debug previews are the UI baseline: `NotesDebugControls` groups task-002 scenarios, `NotesDebugPreview` supplies synthetic recordings, `meetingMock.ts` supplies in-memory states, and `MeetingResultsPanel`/`NoteEditor`/`ChatPanel` render them. Act connects those existing surfaces to persisted processing/Chat data instead of building a parallel UI. Keep previews isolated from real audio, database and provider calls. Preview state and sample text are not proof that the pipeline works. Where a mock-only interaction contradicts a fixed decision, the fixed decision governs: the preview's `Transcribe now` control must not start ASR before the 15-second gate, and a running Recap must not persist placeholder text into Summary.
- Preserve current documentation as the living source: update `README.md`, `docs/product.md`, `docs/architecture.md`, `docs/record-then-process.md` and `docs/bb-integration.md` where their current behavior changes. Earlier `.tasks/` and accepted ADRs are historical and read-only; describe corrections in this task. If an accepted ADR is revised, write a new `Supersedes` ADR and update its existing index.
- Out of scope: live ASR, LLM goodbye classifier/configuration, task manager, new tabs/dashboard, recurring-meeting search, automatic messages/calendar events, voice training/new diarization, new provider plugin layer or native schema rollout.

## 3. Milestone rules (dependencies)

Milestones run sequentially. Each delivers its contracts and verifies its own behavior before the next starts. Consumer milestones begin by checking the actual upstream contract and adapting direct consumers, without a dual legacy path. Only the root integrator runs tests, builds, installs or native rebuilds; agents may write tests and run scoped lint/typecheck, and report test commands. Focused checks happen at milestone boundaries; integration runs one full suite after the cross-domain changes. No production-profile smoke.

## 4. Milestone index

| ID | Name | Depends on | Notes |
| --- | --- | --- | --- |
| M1 | Durable end-of-meeting gate | none | 15-second persisted ASR launch |
| M2 | Speaker names and main Summary | M1 | Corrected transcript, thresholds, prompt, selected-run Summary |
| M3 | Tasks, Recap, Follow-up and formatter | M2 | One Markdown, Chat button, editable Actions, JSON repair |
| M4 | Integrated journeys and documentation | M3 | Cross-route verification, live capture evidence, current docs |
| M5 | Reviewer fixes from review-1 | M4 | Close the scoped findings and recheck affected journeys |
| M6 | Reviewer fixes from review-2 | M5 | Preserve Summary independence and group-specific controls |
| M7 | Reviewer fixes from review-3 | M6 | Unify the main manual Summary route and empty-transcript control |
| M8 | Reviewer fix from review-4 | M7 | Align Results Summary availability with capture eligibility |

## 5. Milestone details

### 5.1 M1 — Durable end-of-meeting gate

#### 5.1.1 Depends on

Depends on: none.

#### 5.1.2 Scope

- Change `src/stores/meetingRecordingStore.ts`, the main-process `MeetingProcessingWorker` in `src/helpers/meetingProcessing.ts`, `src/helpers/database.ts`, recording/processing IPC and `src/contracts/meetingRecording.ts` so End/confirmed auto end can record a pending group run with a durable not-before time. Reuse the existing run `retryAt`/pending worker timer where valid; no external scheduler. Gate the actual prepare/ASR claim on finalized source recordings, elapsed 15 seconds, inactive capture and unchanged meeting group. Resume cancels/invalidates the prior pending launch, and a later end creates the current group version without duplicate processing. A restart resumes only eligible pending work. Keep raw audio and previous artifacts untouched.
- Connect the waiting/countdown, Resume and queued/ASR/error notices already sketched in `src/components/notes/MeetingResultsPanel.tsx` (`gate-waiting` in `NotesDebugPreview`) to the durable run state. The preview currently advances from countdown straight to naming and its `Transcribe now` button bypasses the gate; live behavior follows prepare → ASR → naming and never starts ASR early. Adjust the preview control/copy to match rather than carrying the bypass into production.
- Excludes speaker/LLM/Markdown behavior and their later UI states.
- Contracts produced/changed: meeting processing run timing and launch eligibility. Contracts consumed: existing recording IDs/groups, `MeetingProcessingRunDto` and raw audio state.

#### 5.1.3 Acceptance criteria

- Finalization + 14.999 seconds never starts ASR, including via the mockup's manual control; finalization + 15 seconds can. Pause does not queue it; Resume invalidates it; short recordings still transcribe. Repeated Stop and restart do not duplicate group work. Offline/model errors retain audio and retryable processing state.
- Launch eligibility is rechecked immediately before prepare/ASR and tied to the current meeting group.

#### 5.1.4 Verification

- Extend `test/helpers/meetingProcessing.test.ts`, `test/stores/meetingRecordingStoreAutoEndStop.test.ts` and `test/components/meetingResultsPanel.test.ts` with controlled-clock Stop/Pause/Resume/restart, idempotency and gate-control cases (unit + temporary-DB/renderer integration). Run `pnpm test -- test/helpers/meetingProcessing.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts test/components/meetingResultsPanel.test.ts`; `pnpm run typecheck:main` and `pnpm run typecheck:renderer` for changed contracts. Root runs these sequentially. Manual check at this boundary: compare the `gate-waiting` and queued/ASR/error previews with an isolated live profile; confirm no model work during capture and no early ASR control.

#### 5.1.5 Consumer surfaces impacted

End call/auto end and Resume controls, waiting/queued/ASR/error status in `MeetingResultsPanel`, grouped scenarios in `NotesDebugControls`, IPC/main worker. M2 consumes the delayed run.

#### 5.1.6 Pre-response/loading/success/error/empty states (when applicable)

After End: saved audio and visible waiting/queued processing until deadline. During ASR: existing processing indication. Success: transcript run ready. Failure: explicit failed/blocked status with retry and preserved audio. Empty/short audio: no fabricated transcript; short but usable audio still reaches ASR. Resume: previous pending attempt is invalidated visibly without marking the meeting complete.

### 5.2 M2 — Speaker names and main Summary

#### 5.2.1 Depends on

Depends on: M1.

#### 5.2.2 Scope

- Contract sync: verify M1's delayed run and current-group eligibility before consuming the ready transcript.
- Define one run-scoped source snapshot for LLM work: selected source run, all transcript segments/IDs, speaker correction revision, manual-note revision and prompt/model snapshot. These revisions are application metadata, not model input. For speaker naming, implement strict JSON/domain validation and one repair turn in the same selected-provider conversation, including BB `tell` on its original thread. Refusals, cancellations and transport errors are not JSON repair. Check context capacity before sending; never silently truncate segments.
- After ASR/diarization and existing voice recognition, identify only unknown speaker IDs. English prompt input is exactly `meetingTitle: string|null`, `participants: {name: string|null,email: string|null}[]`, and every `{id,speakerId,speakerName,text}` segment from one run. Calendar display name is a candidate only; preserve nulls when unavailable, never derive a person's name from email or attendee order. Exclude manual notes, Summary, inferred role/RSVP/organizer and double-sent raw transcript text. Ask for `{speakers:[{speakerId,name}]}`; prompt requires evidence in those segments and omission of ambiguous IDs. Code checks schema, nonempty name, speaker IDs from that run, duplicate IDs and current correction state before automatic application; it does not claim to prove the semantic basis of a name. Keep source `model` distinct from `user`; wire the existing `auto` speaker badge and optional correction dialog in `MeetingResultsPanel` to persisted provenance, then show the previewed stale-Summary notice after a correction without silently rewriting the saved Summary. The mock currently derives that badge from `mockPipeline.modelSpeakerIds` alone; live UI must use saved run data. No voice-profile enrollment.
- Update `src/helpers/builtinActions.ts`, `src/helpers/meetingRecordingConfigSnapshot.ts`, `src/helpers/meetingProcessing.ts`, `src/components/notes/PersonalNotesView.tsx` and the existing Actions path so the edited Detailed Notes instruction is the default for **new** auto/manual runs and is frozen per run. The English main prompt requires concise `## TLDR`, descriptive topic headings with attribution and factual uncertainty, optional exact `## Action Items` as last section, and no empty Decisions/Open Questions boilerplate. Output prose/topic headings use the meeting's main language unless the Action instructions explicitly request another; no title, date, attendee-list or other preamble, and return only notes. Feed only meeting title as hint, manual notes as notes, and one full corrected segment projection; no calendar attendees/email, prior Summary/tasks, chat history or unescaped instructions from spoken text. Manual and auto paths use the same snapshot. Duration/text thresholds gate only auto Summary, at 180s/2500 chars inclusively; no Summary during active capture or for stale group/run. Existing ready Summary is not rewritten by naming changes.
- Keep manual note body and old run artifacts intact. Summary success writes the selected-run Markdown and current note projection through the existing run-selection path; reselect/restart reads the same saved version. Existing ready transcript permits manual generation below thresholds. Use the existing Summary tab and `short-meeting`, `naming` and `speakers-auto` preview states, including the optional Regenerate Summary affordance after names change. Excludes priorities, Recap, Follow-up, cleanup and new tabs.
- Contracts produced/changed: run-scoped LLM source snapshot, named transcript projection and source provenance, speaker JSON validation/repair, edited Detailed Notes prompt snapshot, Summary eligibility and saved selected Markdown. Contracts consumed: M1 delayed run and existing provider text/BB thread routes.

#### 5.2.3 Acceptance criteria

- Voice-profile match remains preferred. The prompt asks for transcript-supported unique names; application validation prevents invalid IDs/duplicates and user override. Ambiguous/missing calendar names leave `Speaker N` in controlled prompt-quality scenarios. A user correction, including clearing back to `Speaker N`, is never replaced by a late or restarted naming attempt.
- Both Summary paths see identical current speaker labels and manual notes. Auto Summary starts only at both inclusive thresholds, once per meeting, after ready transcript and inactive capture; short meetings still show transcript and manual Summary using the previewed ineligibility notice. User-edited prompt is used on new generation, while retry uses its existing snapshot. Output begins with TLDR, describes who contributed what, includes only grounded decisions/tasks, and omits `## Action Items` when none.
- A naming error does not block Summary forever; a Summary error leaves transcript/notes and retry path intact. Stale output cannot replace a newly selected/current run.
- Malformed or schema-invalid speaker JSON gets exactly one same-conversation correction with its prior answer and concise validation error; unknown speaker IDs, duplicate IDs, extra fields and empty names are rejected. The prompt and controlled quality checks cover semantic evidence. A refusal or transport error is reported directly. No provider switch or silent segment truncation.

#### 5.2.4 Verification

- Extend `test/helpers/meetingProcessing.test.ts`, speaker persistence/policy tests (`test/helpers/speakerIpc.test.ts`, `test/helpers/speakerAssignmentPolicy.test.ts`, `test/helpers/speakerRetroactiveMapping.test.ts`), and the existing Summary Action/renderer tests. Add `test/cases/ai/integration/meetingJsonRepair.test.ts` for selected-route invalid/repair/refusal and BB original-thread behavior. Controlled-clock unit cases cover 179/180s, 2499/2500 chars, no second delay and duplicate manual/auto request; temporary-DB integration covers correction provenance, restart, custom prompt snapshot and selected-run projection. Renderer cases verify that persisted model provenance drives the `auto` badge, a user correction removes it, Summary shows the stale notice, and Regenerate Summary makes a new result. Run `pnpm test -- test/helpers/meetingProcessing.test.ts test/helpers/speakerIpc.test.ts test/helpers/speakerAssignmentPolicy.test.ts test/helpers/speakerRetroactiveMapping.test.ts test/stores/actionProcessingNoteOutput.test.ts test/components/meetingResultsPanel.test.ts test/cases/ai/integration/meetingJsonRepair.test.ts`, then `pnpm run typecheck:main` and `pnpm run typecheck:renderer`. Manual isolated-profile prompt-quality check with synthetic Russian transcripts: self-introduction, ambiguous address, a calendar invitee who never speaks, a hypothetical task, and no tasks. Record model outputs as quality evidence, not deterministic semantic-validation tests. Compare live naming, auto badge, correction, stale notice and short-meeting state to the committed previews.

#### 5.2.5 Consumer surfaces impacted

Meeting transcript/Speaker picker and `auto` badge, stale-Summary notice, Detailed Notes Action editor, manual Summary control, automatic processing status, Summary tab, notes projection and provider routes. M3 consumes the saved Summary and corrected transcript.

#### 5.2.6 Pre-response/loading/success/error/empty states (when applicable)

Naming pending: keep `Speaker N` until validated. Naming failure/empty: keep `Speaker N`, record bounded error without blocking a later Summary. Auto Summary ineligible: transcript ready and manual Summary available, no misleading failure. Summary loading: preserve prior visible result, show progress. Success: Markdown on Summary tab. Error/context overflow: readable retry state and intact transcript/manual notes; empty Summary response is error, not a successful blank note.

### 5.3 M3 — Tasks, Recap, Follow-up and formatter

#### 5.3.1 Depends on

Depends on: M2.

#### 5.3.2 Scope

- Contract sync: verify M2's named transcript snapshot, selected Summary Markdown and prompt snapshot before adding consumers.
- Extend the speaker JSON repair path only where prioritized tasks and Recap now need the same selected-provider response behavior. Add their strict validators and the revision-checked selected-run Markdown section mutation here, preserving prior artifacts and updating the `note.enhanced_content` projection. Recheck run, source and manual-edit revisions at application; never use last-write-wins.
- Keep the Follow-up and Recap definitions, prompts, translation keys and standalone routing already committed in `src/helpers/builtinActions.ts`; seed these **missing** editable Actions for existing profiles without replacing user edits or changing the existing Follow-up email. Since `src/helpers/database.ts` currently seeds built-ins only when the entire Actions table is empty, migrate by translation key with preservation of customized prompts; complete missing localization, including Russian labels/descriptions, without duplicating the committed definitions.
- After saved Summary, send its text as context plus full corrected segments and manual notes to the English prioritized-task prompt. Exclude calendar people, email, generation date and prior task result. The prompt requires source-grounded action/owner/deadline; code validates exact `{HIGH,MEDIUM,LOW}` arrays, maximum three each, and duplicate strings without claiming to prove semantic grounding. Use this milestone's selected Markdown mutation. Preserve the first Summary while tasks load/fail; expose retry of this stage alone. The parser targets Markdown heading structure, exact `## Action Items` as last Summary section before any Recap, and `## Recap` as separate section. On nonempty tasks with absent/ambiguous heading, report format error rather than append duplicates; on genuinely zero tasks, remove the section. Do not erase unrelated sections or a concurrent Recap/human edit.
- Use the committed Follow-up button in `NoteEditor`/`ChatPanel` for the selected meeting, replacing `runPreviewFollowUp` only on the live path with invocation of the editable Follow-up Action through existing embedded Chat. Store its draft as an ordinary assistant Chat message; preserve the preview's disabled, loading, reply and error states and keep preview responses in memory. Input: title, manual notes, full corrected segments with real start timestamps when available, and only matching current Summary or null. No attendee list/guessed recipient/sender/older chat as meeting fact. Follow-up text prompt requests one draft and a preceding explanation of at most three sentences, cites supporting transcript timestamps only when real timestamps are supplied, and does not invent links; subsequent user chat can refine it. No external send.
- Recap Action is manually invoked for a selected past meeting only if its Summary exists. Use the committed `New recap`/`Update recap` entry in the existing Summary result-actions popover and replace its mock timer with the real Action. Input: title hint, manual notes, full corrected segments and matching saved Summary; no attendee email/other meetings/current date. Strict `{title,bullets}` with a nonempty title ≤58 Unicode code points and 0–3 nonempty bullets ≤88 code points each; insert/update `## Recap` in the same Summary with this milestone's revision guard. Recap and tasks may generate concurrently; writes are serialized. Failure leaves Summary unchanged and permits retry. Show progress as UI notice, not a persisted `_Готовим recap…_` Markdown section.
- Replace the default cleanup instruction in `src/config/prompts/index.ts` and relevant localized prompt/default-retirement sources with the adapted English formatter; keep the existing cleanup recipient and user-owned custom prompts. Escape `<transcript>` delimiter content once and decode its entities once when interpreting; treat everything inside as content. Append exactly one language instruction: for automatic detection preserve the actual language/mix; for an explicit choice use the selected **transcription** language (not UI language) for spelling/punctuation while preserving other spoken languages. Append saved dictionary terms as a JSON spelling-reference list only when nonempty. Preserve meaning, voice, details, numbers/dates without guessed values, and spoken `new line`, `new paragraph`, `scratch that`/`delete that` commands in context. Use numbered lists for explicit enumeration, bullets for spoken lists, ordinary prose otherwise; add greeting/sign-off only if spoken message/letter supports them. Return only plain formatted text: no tags, preamble, answers, decorative headings, bold, horizontal rules, translation or em dash; empty input returns empty output. Do not pass formatter output to meeting attribution or Summary.
- Excludes new tabs, separate results/tasks storage UI, follow-up sending, automatic Recap and provider-wide native-schema changes.
- Contracts produced/changed: built-in Action migration/prompt routing, prioritized-task and Recap strict JSON, selected-Markdown section mutation, Chat button-to-message flow, cleanup text. Contracts consumed: M2 current named transcript/Summary and same-conversation speaker repair pattern.

#### 5.3.3 Acceptance criteria

- A ready Summary appears before tasks finish. The committed `summary-tasks-*` previews supply the loading, HIGH/MEDIUM/LOW, zero, provider-error, custom-format-error and edit-conflict states in the existing Summary tab; live data replaces `composeMockSummary`/mock timers. At most three grounded tasks/category replace its initial Action Items without duplication; zero tasks remove that section. Invalid JSON or incompatible custom Markdown leaves Summary unchanged with a retryable error. A concurrent Recap or user edit cannot be lost.
- Existing users see editable new Actions without reset; customized old Actions remain unchanged. Follow-up button writes to same Chat and works with `summary=null`; user can refine it; existing Follow-up email still works. Recap is optional/manual, restricted to saved Summary, and adds only one section. No new visible tab.
- Cleanup output preserves meaning and spoken commands, treats transcript as data, and does not affect source transcript or attribution. BB malformed JSON repair uses the original BB thread; exhaustion preserves prior successful artifacts.

#### 5.3.4 Verification

- Extend action seed/persistence tests (`test/helpers/actionsCatalogBehavior.test.ts`, `test/helpers/actionsIpc.test.ts`), `test/stores/actionProcessingNoteOutput.test.ts`, `test/components/meetingResultsPanel.test.ts`, `test/helpers/retiredPrompts.test.ts`, and the existing embedded Chat harness. Add `test/cases/notes/integration/meetingSummarySections.test.ts` for section merge/revision/races and `test/cases/notes/integration/meetingActions.test.ts` for Action seed/reopen, Chat/Recap flow and task/Recap JSON validation. Temporary-DB reopen verifies old custom Actions and selected Markdown; controlled async tests verify tasks/Recap race, human-edit conflict and retry; extend `test/cases/ai/integration/meetingJsonRepair.test.ts` for task/Recap malformed/repair/refusal, including BB's original thread. Renderer cases verify the committed `ChatPanel` button's disabled/loading/message/error states, Recap popover entry and task/Recap notices using persisted data rather than `mockPipeline`. Run `pnpm test -- test/helpers/actionsCatalogBehavior.test.ts test/helpers/actionsIpc.test.ts test/stores/actionProcessingNoteOutput.test.ts test/components/meetingResultsPanel.test.ts test/helpers/retiredPrompts.test.ts test/cases/notes/integration/meetingSummarySections.test.ts test/cases/notes/integration/meetingActions.test.ts test/cases/ai/integration/meetingJsonRepair.test.ts`, then `pnpm run typecheck:main` and `pnpm run typecheck:renderer`. Manual isolated-profile check: use the grouped Task 2 debug scenarios to compare waiting/zero/errors/Recap/Chat states with the live meeting UI, edit an Action, generate Follow-up/Recap, inspect one Summary and cleanup output. With controlled Russian synthetic transcripts, assess priority labels, absent owner/deadline, no tasks, Recap brevity and one grounded Follow-up draft; record model outputs as quality evidence.

#### 5.3.5 Consumer surfaces impacted

Actions catalogue/editor, Chat panel, Summary tab, run selection and notes projection, formatter settings, BB and other selected text routes.

#### 5.3.6 Pre-response/loading/success/error/empty states (when applicable)

Tasks: Summary remains visible while loading; success updates it; zero is successful without task heading; provider/validation/format/conflict errors retain text and show retry. Follow-up: button disabled until transcript ready; loading lives in existing Chat; success is an assistant message; error stays a Chat error with no phantom message. Recap: unavailable before Summary; running state preserves Summary; success adds one section; empty/invalid response or conflict leaves it intact. Cleanup: existing loading/error surface remains, no empty success for a failed model response.

### 5.4 M4 — Integrated journeys and documentation

#### 5.4.1 Depends on

Depends on: M3.

#### 5.4.2 Scope

- Contract sync: confirm all M1–M3 persisted, IPC, prompt and UI shapes are consistent before final integration; remove any replaced old path rather than maintaining duplicate behavior.
- Update `README.md` and `docs/product.md` with the end-of-meeting flow, one Summary, optional Chat Follow-up/Recap and scope. Update `docs/architecture.md` and `docs/record-then-process.md` with the 15-second durable gate, source/projection ownership, provider/JSON repair contract, run/version safety, states and remaining live-hardware limits. Update `docs/bb-integration.md` with same-thread JSON repair and its actual adapter limitation. Do not rewrite historical `.tasks/` or accepted ADRs.
- Integrate final UI and provider routes, verify exact input exclusions with fixtures, and inspect the complete source-to-display journey against committed `gate-waiting`, `naming`, `short-meeting`, `speakers-auto`, `summary-tasks-*`, `summary-recap-*` and `chat-follow-up` previews. Keep the collapsible scenario groups from `7ad33cf2f` as an isolated debug review aid; production UI must obtain every displayed status from real processing/Chat state, with no synthetic timestamps, mock timers, or hard-coded meeting text. No new features.
- Contracts produced/changed: current documentation of implemented contracts. Contracts consumed: M1–M3 contracts.

#### 5.4.3 Acceptance criteria

- End → finalized tracks → 15-second gate → ASR → optional naming → thresholded Summary → optional tasks works after app restart; manual Summary/Follow-up/Recap work in their approved states. Run selection and retries preserve correct version, prior results, manual notes and raw tracks. Each selected provider route either produces validated JSON or a visible failure; no unverified native-schema claim.
- The real Notes UI follows the committed mockups' existing tabs, popovers, badges, Chat button and notices; all mock-only transitions remain confined to Debug preview. `Transcribe now` cannot bypass the 15-second rule, and Recap loading does not write placeholder Markdown.
- Current docs match shipped behavior and explicitly separate automated test evidence from live mic/system/provider evidence.

#### 5.4.4 Verification

- Root runs focused failed files first if needed, then **sequentially** `pnpm run lint`, `pnpm run typecheck`, `pnpm test` once for integrated cross-domain/database/provider/renderer changes, and `git diff --check`. Inspect `pnpm test --list` if files/registry entries move. No simultaneous test/build/install processes. Manual isolated `--user-data-dir` smoke: real macOS mic+system capture with Pause/Resume/End, 15-second waiting, a short meeting, Summary threshold crossing, speaker edit, same Chat Follow-up and Recap; test representative configured routes including BB if credentials are available. Record any unavailable hardware/paid-provider checks as unverified, not passed. No package build unless touched output requires it under quality steering.

#### 5.4.5 Consumer surfaces impacted

Whole meeting journey, Notes, Summary, transcript speaker correction, Actions, Chat, selected providers, current product/architecture documentation.

#### 5.4.6 Pre-response/loading/success/error/empty states (when applicable)

Confirm M1–M3 states stay coherent across restart, run selection, retry, provider failure, short/empty meeting and optional Actions. No empty state implies a fabricated success; preserved data remains accessible after failures.

### 5.5 M5 — Reviewer fixes from review-1

#### 5.5.1 Depends on

Depends on: M4.

#### 5.5.2 Scope

- Resolve the exact findings M1-1, M2-1, M2-2, M2-3, M2-4 and M3-1 in the committed [review-1.md](review-1.md), without expanding the task or changing the original milestone intent. The corresponding contract violations must stop reproducing.
- Root records the outcome of M4-1's isolated live journey where the required macOS hardware and configured routes are available; an unavailable boundary remains explicitly unverified rather than described as passed.
- Preserve the finalized-track 15-second gate, selected run and prior artifacts, optional correction precedence, strict JSON repair, edited Action prompts, one Summary Markdown with revision-safe task/Recap sections, existing Chat, and Debug preview isolation.

#### 5.5.3 Acceptance criteria

- A paused or active meeting cannot start ASR via a manual control before final End plus 15 seconds. Naming and priority instructions enforce the exact evidence and category policies in section 2. Corrupt stored participant data is visible as an error, not an empty candidate list. A short ready transcript shows the ineligibility reason and keeps manual Summary available. The default Summary omits owner/deadline when absent.
- Previously passing M1–M4 behavior and data preservation remain true. M4-1's evidence boundary is recorded accurately.

#### 5.5.4 Verification

- Add focused regressions for each review finding at its affected route and UI consumer; root runs those plus the affected M1–M4 tests sequentially. Root reruns lint, typecheck and the full suite once after the fix is integrated, then requests another milestone review. A live isolated-profile check is recorded separately from automated evidence.

### 5.6 M6 — Reviewer fixes from review-2

#### 5.6.1 Depends on

Depends on: M5.

#### 5.6.2 Scope

- Resolve the exact new findings M5-1, M5-2 and M5-3 in the committed [review-2.md](review-2.md), without broadening the original meeting workflow. Preserve the resolved `review-1.md` findings and M1–M4 invariants.
- Root continues the isolated live journey for recurring M4-1 with a separate test profile and records which hardware/UI/provider boundaries were actually observed; startup alone is insufficient.

#### 5.6.3 Acceptance criteria

- Corrupt optional calendar candidates produce a visible naming error but do not prevent a ready transcript from reaching manual or eligible automatic Summary. An empty transcript does not promise a manual Summary. A pending gate on a newer recording group does not disable manual work on an older completed group whose gate elapsed, while current-group ASR remains gated.
- Raw tracks, prior run artifacts, manual notes, speaker correction precedence, one Summary Markdown and safe task/Recap writes remain intact.

#### 5.6.4 Verification

- Add focused regression coverage for each finding. Root runs affected tests, lint, typecheck and the full suite sequentially, then requests another milestone review. Record isolated live evidence separately from automated results.

### 5.7 M7 — Reviewer fixes from review-3

#### 5.7.1 Depends on

Depends on: M6.

#### 5.7.2 Scope

- Resolve M2-1 and M6-1 in the committed [review-3.md](review-3.md). The main toolbar's manual Summary action must use the same selected-run processing and saved Summary artifact as the Results control. The empty-transcript state must not offer that action. Do not add another Summary store, separate tab, or parallel Action route.
- Preserve M1–M6's finalized-track gate, selected-run corrected speaker projection, manual notes, frozen prompt/model snapshot, input exclusions, user correction precedence, existing Summary Markdown, tasks/Recap consumers and Chat Follow-up. Preserve previous runs/artifacts and edits. Root records the separate M4-1 live-verification boundary accurately.

#### 5.7.3 Acceptance criteria

- Either visible manual Summary affordance starts the same selected-run Summary operation and persists one run artifact and its note projection. Calendar participants/email and raw/live transcript bypass do not enter this request. Regeneration, run reselection, tasks and Recap observe the saved result.
- An empty saved transcript, including the `"[]"` projection, exposes no manual Summary action. A short nonempty ready transcript still offers manual Summary, subject to the existing capture/run eligibility rules. Loading, failure and retry states remain coherent.

#### 5.7.4 Verification

- Add focused renderer and processing regressions that exercise the owning toolbar, selected-run request/persistence, and empty versus short nonempty transcript states. Root runs affected tests, lint, typecheck and the full suite sequentially, then requests another milestone review. Record isolated live evidence separately from automated results.

### 5.8 M8 — Reviewer fix from review-4

#### 5.8.1 Depends on

Depends on: M7.

#### 5.8.2 Scope

- Resolve M7-1 in the committed [review-4.md](review-4.md). The Results `New Summary` affordance must reflect the same selected-run and capture eligibility as the toolbar, with no enabled control that silently returns without a request. Keep the common selected-run Summary path established in M7.
- Preserve M1–M7's capture gate, older run history, empty-transcript exclusion, short nonempty manual eligibility outside capture, saved Summary artifact and Markdown projection, speaker correction precedence, tasks/Recap and Chat Follow-up. M4-1 live verification remains a separate root-owned evidence boundary.

#### 5.8.3 Acceptance criteria

- During preparing, recording, paused or saving capture, an older selected transcript does not show an actionable `New Summary` item. When capture no longer blocks Summary, the eligible action starts the selected-run request and exposes its normal loading/error states. Empty transcript still offers no manual Summary.

#### 5.8.4 Verification

- Add a focused renderer regression at the Results menu consumer for active-capture versus eligible selected-run states. Root runs the affected renderer and processing tests, lint, typecheck and the integrated suite as required, then requests milestone review. Root records any live evidence separately.

## 6. Execution order (derived from dependencies)

M1 → verify M1 → M2 contract sync/implementation/verification → M3 contract sync/implementation/verification → M4 contract sync, integrated checks and current docs → M5 reviewer fixes and affected verification → M6 reviewer fixes and affected verification → M7 reviewer fixes and affected verification → M8 reviewer fix and affected verification. During Act, root runs expensive checks sequentially and records evidence per milestone. Approval of this plan is required before M1.

## Orchestration (managed by orchestrator)

| Milestone | Status | Commits |
| --- | --- | --- |
| M1 — Durable end-of-meeting gate | done | `49d8e48c6`, `a51f0d71d`, `5ec61f8d5`, `256e62d90`, `ef9649b92`, `c329e9330`, `16421a5bc`, `73818b264`, `901a1a3c7`, `153133af7`, `a0226e46d`, `a2828a925`, `3c6b80954`, `576c7202b` |
| M2 — Speaker names and main Summary | done | `394f19c63`, `54dcc96fe`, `1d2563337`, `e8ae4e6ea`, `2ba71bd87`, `abeba8f7a`, `6c7ec570c`, `2e1b17d85` |
| M3 — Tasks, Recap, Follow-up and formatter | done | `2e0cdb78a`, `6413c6434`, `353598a08`, `0967952a6`, `e0487ce3c`, `8333a93a6` |
| M4 — Integrated journeys and documentation | done | `9a14da5c5`, `52a9d2ba1`, `2f9a8c2f0`, `b113ef8bf`, `16df60571` |
| M5 — Reviewer fixes from review-1 | done | `51f587d23`, `0d3cca9c2`, `d733f5f39`, `c4b5f9865`, `8e790528e`, `bea026706` |
| M6 — Reviewer fixes from review-2 | done | `9873d1650`, `71389b117`, `a38587ca5`, `34bbf64dd` |
| M7 — Reviewer fixes from review-3 | done | `f4b8dfc46`, `1c5f72b44` |
| M8 — Reviewer fix from review-4 | done | `eb3fac552`, `473b59794` |
| Reviewer | done | `review-1.md`, `review-2.md`, `review-3.md`, `review-4.md`, `review-5.md` |
| Code Reviewer | not started | |

Review outcome: blocked. `review-5.md` confirms M1–M3 and M5–M8 pass with no remaining code findings. M4-1 remains the same unverified live mic/system/provider journey after multiple reviewer-fix milestones; isolated startup reached onboarding only. Per the PlanAct convergence rule, do not add another blind fix milestone or start code review while this required evidence is missing. Await the user's answer on test recording/access.
