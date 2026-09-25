const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/uploadNotes.ts");
const { MAX_SPEAKER_COUNT } = require("../../src/constants/speakerDetection.json");
const { parseTranscriptSegments } = require("../../src/utils/parseTranscriptSegments.ts");

test("maps the diarizer invocation onto the note columns", async () => {
  const { buildUploadNoteMetadata } = await load();

  const { audioDurationSeconds, noteUpdates } = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: 2 },
    4359.87
  );

  assert.equal(audioDurationSeconds, 4359.87);
  assert.deepEqual(noteUpdates, { diarization_enabled: 1, expected_speaker_count: 2 });
});

test("auto speaker detection stores no explicit count", async () => {
  const { buildUploadNoteMetadata } = await load();

  const { noteUpdates } = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: null },
    60
  );

  // isExplicitSpeakerCount treats any positive integer as the user's own
  // choice, so auto detection must land as null, never a default.
  assert.equal(noteUpdates.expected_speaker_count, null);
  assert.equal(noteUpdates.diarization_enabled, 1);
});

test("disabled diarization writes no columns at all", async () => {
  const { buildUploadNoteMetadata } = await load();

  // A null diarization_enabled defers to the global speaker setting when the
  // user records into the note later (a 0 would force it off), and writing no
  // count keeps the numSpeakers value lingering in localStorage while its
  // input is hidden from being stamped onto the note as an explicit choice.
  const { audioDurationSeconds, noteUpdates } = buildUploadNoteMetadata(
    { enabled: false, localModelsReady: false, numSpeakers: 3 },
    120
  );

  assert.equal(noteUpdates, null);
  assert.equal(audioDurationSeconds, 120);
});

// Uploads persist numSpeakers through the shared stored-count normalizer
// (src/helpers/speakerCount.ts, also used by the main process). Pin the
// outcomes explicitly instead of comparing against a second call.
test("speaker counts normalize through the shared stored-count clamp", async () => {
  const { buildUploadNoteMetadata } = await load();

  const above = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: MAX_SPEAKER_COUNT + 5 },
    null
  );
  assert.equal(above.noteUpdates.expected_speaker_count, MAX_SPEAKER_COUNT);

  const unusable = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: 0 },
    null
  );
  assert.equal(unusable.noteUpdates.expected_speaker_count, null);

  const auto = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: null },
    null
  );
  assert.equal(auto.noteUpdates.expected_speaker_count, null);
});

test("unusable durations degrade to null", async () => {
  const { buildUploadNoteMetadata } = await load();
  const diarization = { enabled: true, localModelsReady: true, numSpeakers: 2 };

  for (const value of [null, undefined, 0, -1, NaN, Infinity]) {
    assert.equal(
      buildUploadNoteMetadata(diarization, value).audioDurationSeconds,
      null,
      `expected ${value} to degrade to null`
    );
  }
});

test("provider segments serialize into the meeting-path transcript shape", async () => {
  const { buildUploadTranscript } = await load();

  const anchorMs = 1_700_000_000_000;
  const transcript = buildUploadTranscript(
    [
      { text: " Hello world. ", start: 0, end: 4.2 },
      { text: "Named part.", start: 4.2, end: 7.5, speaker: "Speaker 1" },
    ],
    anchorMs
  );

  // Timestamps are epoch-anchored ms, the meeting path's base: exports rebase
  // off the minimum (guarded by min > 1e9), and live segments appended by a
  // later meeting recording on the same note share the base instead of mixing
  // relative seconds with Date.now() values.
  assert.deepEqual(JSON.parse(transcript), [
    { text: "Hello world.", timestamp: anchorMs },
    { text: "Named part.", timestamp: anchorMs + 4200, speakerName: "Speaker 1" },
  ]);
  const parsed = parseTranscriptSegments(transcript);
  assert.equal(
    parsed[0].source,
    undefined,
    "a single mixed/upload transcript carries no false mic/system origin"
  );
  assert.equal(parsed[1].speakerName, "Speaker 1");
  assert.equal(parsed[1].speaker, "Speaker 1", "provider labels remain visible in Transcript");
  assert.equal(
    parsed[1].speakerStatus,
    "provisional",
    "provider labels are not confirmed identities"
  );
});

test("Upload keeps the transcript in Transcript and leaves Notes editable", async (t) => {
  const { saveUploadNote } = await load();
  const calls = [];
  const originalWindow = global.window;
  t.after(() => {
    global.window = originalWindow;
  });
  global.window = {
    electronAPI: {
      saveNote: async (...args) => {
        calls.push({ kind: "save", args });
        return { success: true, note: { id: 42, content: args[1] } };
      },
      updateNote: async (id, updates) => {
        calls.push({ kind: "update", id, updates });
        return { success: true, note: { id, ...updates } };
      },
    },
  };

  const saved = await saveUploadNote({
    title: "Call",
    text: "Spoken words.",
    sourceName: "call.wav",
    folderId: null,
    diarization: { enabled: false, localModelsReady: false, numSpeakers: null },
  });
  assert.equal(
    calls[0].args[1],
    "Spoken words.",
    "initial save protects the text if metadata fails"
  );
  assert.equal(calls[1].updates.content, "");
  assert.equal(JSON.parse(calls[1].updates.transcript)[0].text, "Spoken words.");
  assert.equal(saved.note.content, "");
});

test("a failed transcript write leaves the original text in Notes", async (t) => {
  const { saveUploadNote } = await load();
  const originalWindow = global.window;
  t.after(() => {
    global.window = originalWindow;
  });
  global.window = {
    electronAPI: {
      saveNote: async () => ({ success: true, note: { id: 42, content: "Spoken words." } }),
      updateNote: async () => {
        throw new Error("write failed");
      },
    },
  };
  const saved = await saveUploadNote({
    title: "Call",
    text: "Spoken words.",
    sourceName: "call.wav",
    folderId: null,
    diarization: { enabled: false, localModelsReady: false, numSpeakers: null },
  });
  assert.equal(saved.note.content, "Spoken words.");
});

test("the default anchor is the current epoch so later meeting appends share one base", async () => {
  const { buildUploadTranscript } = await load();

  const before = Date.now();
  const stored = JSON.parse(buildUploadTranscript([{ text: "Hi.", start: 1.5 }]));
  const after = Date.now();

  assert.ok(
    stored[0].timestamp >= before + 1500 && stored[0].timestamp <= after + 1500,
    `expected ${stored[0].timestamp} to sit 1.5s after an epoch-ms anchor in [${before}, ${after}]`
  );
});

// The record button on any editable note seeds a meeting recording from
// note.transcript and appends Date.now()-stamped live segments. Pin that an
// upload transcript mixed with those appends exports sane cue times — a
// relative-seconds base would keep resolveRecordingStartMs at ~0, skip the
// epoch rebase, and render the appended segments as ~481,000,000-hour cues.
test("upload transcripts mixed with later live meeting segments export sane SRT times", async () => {
  const { buildUploadTranscript } = await load();
  const { formatSrt } = require("../../src/helpers/transcriptFormatter");

  const anchorMs = 1_700_000_000_000;
  const seeded = JSON.parse(
    buildUploadTranscript(
      [
        { text: "Uploaded intro.", start: 0, end: 3 },
        { text: "Uploaded detail.", start: 30, end: 33 },
      ],
      anchorMs
    )
  );
  const appended = [{ text: "Live follow-up.", source: "mic", timestamp: anchorMs + 60_000 }];

  const output = formatSrt([...seeded, ...appended], {});
  assert.match(output, /^1\n00:00:00,000 --> 00:00:30,000\nUnknown Speaker: Uploaded intro\./);
  assert.match(output, /\n2\n00:00:30,000 --> 00:01:00,000\nUnknown Speaker: Uploaded detail\./);
  assert.match(output, /\n3\n00:01:00,000 --> 00:01:03,000\nYou: Live follow-up\./);
});

test("unusable segments produce no transcript at all", async () => {
  const { buildUploadTranscript } = await load();

  assert.equal(buildUploadTranscript(undefined), undefined);
  assert.equal(buildUploadTranscript(null), undefined);
  assert.equal(buildUploadTranscript([]), undefined);
  assert.equal(
    buildUploadTranscript([
      { text: "   ", start: 0 },
      { text: "no start", start: NaN },
    ]),
    undefined
  );
});

test("segments persist the transcript even when diarization is off", async () => {
  const { buildUploadNoteMetadata } = await load();

  const anchorMs = 1_700_000_000_000;
  const { noteUpdates } = buildUploadNoteMetadata(
    { enabled: false, localModelsReady: false, numSpeakers: null },
    60,
    [{ text: "Hello.", start: 0, end: 2 }],
    anchorMs
  );

  // The transcript must not drag the diarization columns along: a null
  // diarization_enabled still defers to the global speaker setting.
  assert.deepEqual(noteUpdates, {
    transcript: JSON.stringify([{ text: "Hello.", timestamp: anchorMs }]),
  });
});

test("segments and diarization metadata share one noteUpdates write", async () => {
  const { buildUploadNoteMetadata } = await load();

  const anchorMs = 1_700_000_000_000;
  const { noteUpdates } = buildUploadNoteMetadata(
    { enabled: true, localModelsReady: true, numSpeakers: 2 },
    60,
    [{ text: "Hi.", start: 1, speaker: "Speaker 1" }],
    anchorMs
  );

  assert.deepEqual(noteUpdates, {
    diarization_enabled: 1,
    expected_speaker_count: 2,
    transcript: JSON.stringify([
      { text: "Hi.", timestamp: anchorMs + 1000, speakerName: "Speaker 1" },
    ]),
  });
});

test("upload titles fall back to the transcript, then the file name", async () => {
  const { uploadTitleFallback } = await load();

  assert.equal(uploadTitleFallback("one two three", "board.m4a"), "one two three");
  assert.equal(
    uploadTitleFallback("one two three four five six seven", "board.m4a"),
    "one two three four five six..."
  );
  assert.equal(uploadTitleFallback("   ", "board-meeting.m4a"), "board-meeting");
});
