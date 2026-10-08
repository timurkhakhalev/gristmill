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
    { invoke: () => api.getContactProfiles(["person@example.com"]), row: { email: "person@example.com", display_name: "Person", photo_url: null } },
    { invoke: () => api.getSpeakerMappings(1), row: { note_id: 1, speaker_id: "S1", profile_id: null, display_name: "Person" } },
    { invoke: () => api.getSpeakerProfiles(), row: { id: 1, display_name: "Person", email: null, sample_count: 1 } },
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
  assert.deepEqual(calls[0], ["get-contact-profiles", ["person@example.com"]]);
});
