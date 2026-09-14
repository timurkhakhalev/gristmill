# M2 server product-layer removal manifest

This manifest is the hand-off from M2 to M7. M2 removed the renderer-facing
server product modules and left shared process wiring untouched so the final
cutover can be made in one pass. The entries below are symbol-level removal
targets; they are not compatibility shims.

## Shared imports and calls

M7 must remove the remaining imports and call sites in `main.js`,
`src/helpers/ipcHandlers.js`, and `preload.js` for:

- `accountScopeBinding`: `read`, `clear`, `persist`,
  `resolveBootAccountScope`, `resolveActiveAccountScope`,
  `matchesActiveAccountScope`, and `evaluateScopeRequest`.
- cloud request and policy helpers: `createCloudApiRequestHandler`,
  `ANALYTICS_HISTORY_BACKFILL_VERSION`, `createWorkspacePolicyManager`,
  `workspacePolicyManager.getPolicy`, `createEnterpriseIdentityManager`,
  `enterpriseIdentityManager.resolveProvider`, `enterpriseIdentityManager.getConfig`,
  and its `clear` calls.
- cloud sync state and event plumbing: `updateNoteCloudId`,
  `updateNoteShareState`, `upsertSpaceFromCloud`, `setSpaceSyncStatus`,
  `onSpaceSynced`, `onNoteSynced`, `onFolderSynced`, `emitSyncEvent`,
  `onSyncEvent`, `updateAgentConversationCloudId`, and all cloud CRUD bridge
  methods. Keep local note, folder, conversation, and capture event methods.
- server account/auth/entitlement calls: `authGetToken`, `authGetTokenState`,
  `authSetToken`, `cloudUsage`, `cloudCheckout`, `cloudBillingPortal`,
  `cloudSwitchPlan`, `cloudPreviewSwitch`, `cloudApiRequest`, and the
  `getReferralStats`, `sendReferralInvite`, `getReferralInvites` bridges.
- analytics and engagement calls: all `analytics-*` handlers and listeners,
  `copyLeaderboardImage`, `saveLeaderboardImage`, leaderboard IPC, and their
  pending-upload/delete lifecycle.
- invitation/share/team/workspace calls: invitation deep-link parsing and
  forwarding, `pendingNoteCloudId`, `parseNoteCloudId`,
  `flushPendingNoteDeepLink`, workspace policy IPC, team/space membership and
  share IPC, and `performSyncTeardown`/server sync lifecycle hooks.

`transcribeAudioFileCloud` and managed inference routing are a coordination
point with M3. Remove only the server-managed path; retain direct BYOK,
Local, and Self-Hosted provider paths and provider API-key authentication.

## Types and settings

In `src/types/electron.ts`, remove server-only account/session,
subscription/usage/trial/billing, cloud sync, workspace/team/member/share,
invitation, referral/leaderboard, analytics-upload, and managed-policy IPC
types and declarations. Remove fields used only for those declarations from
settings state (including signed-in account values, cloud backup/sync,
insights upload, subscription/trial/billing, referral/leaderboard, workspace
IDs, and managed-policy state). Keep local note/chat state, calendar OAuth,
provider API-key settings, custom endpoints, direct enterprise credentials,
keychain state, and capture settings.

M7 owns the edits to `src/types/electron.ts` and `src/stores/settingsStore.ts`;
M2 intentionally did not edit those shared files.

## Database and schema

M7 must remove server-only columns, tables, migrations, and accessors from
`src/helpers/database.js` and its schema while preserving local data:

- cloud IDs and revisions: `cloud_id`, `cloud_updated_at`,
  `client_note_id`, `client_folder_id`, `client_conversation_id`,
  `client_transcription_id`, `cloud_space_id`, `cloud_team_id`;
- sharing/ownership transport: `is_shared`, `share_token`, `workspace_id`,
  `owner_user_id`, `created_by_user_id`, `updated_by_user_id`, `left_team`;
- sync/analytics transport: `sync_status`, `deleted_at`, analytics event
  upload/claim/delete methods, pending vector purge queues, and cloud
  conflict/base/retry methods;
- workspace/team membership and server-space tables and queries.

Keep local notes, folders, conversations, FTS/search, dictionary/snippets,
calendar data, capture logs/events, and local speaker/transcript data.

## Renderer consumers and i18n

M7 must remove imports and render paths from the shared consumers
`src/App.jsx`, `src/components/ControlPanel*`, `controlPanelNav`,
`OnboardingFlow`, `SettingsPage`/`SettingsModal`, `settingsStore`, and the
notes/space tree/editor consumers that still reference the deleted modules.
This includes auth/reauthentication, upgrade/paywall, billing/usage, cloud
sync, sharing, invitations, teams/workspaces, managed policy, referral,
leaderboard, insights, and analytics-upload UI.

Remove the corresponding translation namespaces/keys for those features,
including `noteEditor.share.*`, `notes.spaces.*` sharing/team/conflict keys,
auth/account/SSO, subscription/usage/billing/trial, integrations API/MCP/CLI,
workspace/team/invitation, referral/leaderboard, insights, analytics, and
managed-policy text. Preserve calendar, provider API-key, local notes/chat,
dictionary/snippet, and capture/transcription error keys.

## M2 tests

The removed owned surface also includes the email/password auth dialogs,
usage and post-checkout refresh hooks, the cloud note-create acknowledgement
helper, and the Insights consent coordinator. Any remaining imports of these
paths are shared-consumer cleanup for M7.

`test/m2ServerLayerRemovalContract.test.js` pins the owned module boundary and
the calendar-only integrations surface. It is intentionally not run during
the parallel cleanup. After M7 completes the shared cutover, run:

```sh
node --test --test-concurrency=1 test/m2ServerLayerRemovalContract.test.js
```
