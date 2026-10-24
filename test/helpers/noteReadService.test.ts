const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

// The service's transitive chain (database.ts) loads debugLogger, which imports
// electron at module load; under plain node and the mutation image the loader
// hands it this stub.
const { installElectronStub }: typeof import("./harness/electronStub.ts") = require("./harness/electronStub.ts");

installElectronStub();

const {
  NoteReadService,
}: typeof import("../../src/helpers/noteReadService.ts") = require("../../src/helpers/noteReadService.ts");

const notes = [
  {
    id: 2,
    title: "Other",
    content: "",
    enhanced_content: null,
    transcript: JSON.stringify([
      { text: "Релиз перенесён на четверг", speaker: "Ann", timestamp: 5, endTimestamp: 9 },
    ]),
    participants: null,
    created_at: "2026-09-28 09:00:00",
  },
  {
    id: 1,
    title: "Релиз",
    content: "Check QA",
    enhanced_content: "Summary",
    transcript: null,
    participants: null,
    created_at: "2026-09-27 09:00:00",
  },
];

const db = {
  listAllNotes: () => notes,
  getNote: (id: number) => notes.find((note) => note.id === id) ?? null,
  listMeetingRecordingsForNote: () => [],
  listMeetingRecordingEpochs: () => [],
  getMeetingProcessingRun: () => null,
  getMeetingRunSpeakerCorrections: () => [],
  getSpeakerProfiles: () => [],
  getContactNames: () => null,
};

const storage = { readRunArtifact: () => null };

const reader = new NoteReadService(db as never, storage as never);

test("search scans every Note transcript after finding Note content", () => {
  const result = reader.search("Рел");
  assert.deepEqual(
    result.notes.map((hit) => hit.note_id),
    [1]
  );
  assert.deepEqual(
    result.transcripts.map((hit) => hit.note_id),
    [2]
  );
  assert.equal(result.transcripts[0].matches[0].start_ms, 5000);
  assert.deepEqual(reader.search("unmatched"), { query: "unmatched", notes: [], transcripts: [] });
});

test("list keeps empty Notes and uses inclusive local dates", () => {
  assert.deepEqual(
    reader.list().notes.map((note) => note.id),
    [2, 1]
  );
  assert.deepEqual(
    reader.list({ from: "2026-09-28", to: "2026-09-28" }).notes.map((note) => note.id),
    [2]
  );
  assert.deepEqual(
    reader.list({ withTranscript: true }).notes.map((note) => note.id),
    [2]
  );
});
