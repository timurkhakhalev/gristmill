const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { loadBundledPreload, plain }: typeof import("../../../../helpers/harness/bundledPreload.ts") = require("../../../../helpers/harness/bundledPreload.ts");
type SpeakerApi = import("../../../../../src/contracts/speakerProfiles.ts").SpeakerApi;

test("bundled speaker bridge accepts empty and populated lists and rejects invalid rows", async () => {
  let response: unknown = [];
  const calls: unknown[][] = [];
  const api = loadBundledPreload<SpeakerApi>({
    invoke: async (channel, ...args) => { calls.push([channel, ...args]); return response; },
  });
  const operations = [
    { invoke: () => api.getContactProfiles([7]), row: { id: 7, telegram_username: null, email: "person@example.com", display_name: "Person", photo_url: null } },
    { invoke: () => api.getSpeakerMappings(1), row: { note_id: 1, speaker_id: "S1", profile_id: null, display_name: "Person" } },
    { invoke: () => api.getSpeakerProfiles(), row: { id: 1, display_name: "Person", contact_id: null, sample_count: 1 } },
  ];
  for (const operation of operations) {
    response = [];
    assert.deepEqual(plain(await operation.invoke()), []);
    response = [operation.row];
    assert.deepEqual(plain(await operation.invoke()), [operation.row]);
    for (const invalid of [{}, [null], [{ unrelated: true }]]) {
      response = invalid;
      await assert.rejects(operation.invoke());
    }
  }
  assert.deepEqual(calls[0], ["get-contact-profiles", [7]]);
});

test("bundled contact writes and speaker mapping parse concrete result DTOs", async () => {
  let response: unknown = { success: true };
  const api = loadBundledPreload<SpeakerApi>({ invoke: async () => response });
  const input = { displayName: "Synthetic Sample", email: null, telegramUsername: null };
  await assert.rejects(api.createContact(input));
  await assert.rejects(api.updateContact(1, input));
  await assert.rejects(api.setSpeakerMapping(1, "speaker", "Synthetic", null));
  response = { success: false, error: "email_conflict", existingContactId: 7 };
  assert.deepEqual(plain(await api.createContact(input)), response);
  response = { success: true, profileId: null };
  assert.deepEqual(plain(await api.setSpeakerMapping(1, "speaker", "Synthetic", null)), response);
});

test("legacy mention bridge validates nullable positive contact IDs", async () => {
  let response: unknown = [{ email: "old@example.com", contactId: 7 }, { email: "absent@example.com", contactId: null }];
  const api = loadBundledPreload<SpeakerApi>({ invoke: async () => response });
  assert.deepEqual(plain(await api.resolveLegacyMentionContacts(["old@example.com"])), response);
  response = [{ email: "old@example.com", contactId: 0 }];
  await assert.rejects(api.resolveLegacyMentionContacts(["old@example.com"]));
});
