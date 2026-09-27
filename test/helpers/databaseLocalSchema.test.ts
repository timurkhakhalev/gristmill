const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const source = fs.readFileSync(path.join(root, "src/helpers/database.ts"), "utf8");

test("database source defines only the clean local schema", () => {
  for (const name of [
    "account_id",
    "cloud_id",
    "cloud_updated_at",
    "sync_status",
    "analytics_events",
    "space_accounts",
    "workspace_id",
    "share_token",
    "client_note_id",
    "upsertNoteFromCloud",
    "markNoteSynced",
  ]) {
    assert.equal(source.includes(name), false, `${name} must not remain in the database layer`);
  }
});

test("database source keeps local notes, chat, capture and calendar tables", () => {
  for (const table of [
    "transcriptions",
    "notes",
    "folders",
    "spaces",
    "agent_conversations",
    "agent_messages",
    "notes_fts",
    "speaker_profiles",
    "speaker_mappings",
    "custom_dictionary",
    "snippets",
    "google_calendar_tokens",
    "microsoft_calendar_tokens",
    "apple_calendars",
    "calendar_events",
  ]) {
    assert.match(source, new RegExp(`CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(source, /sync_token TEXT/);
  assert.match(source, /sync_token_expires_at INTEGER/);
});
