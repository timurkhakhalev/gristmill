const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/utils/llmTranscript.js");

type TranscriptSegment =
  import("../../src/contracts/meetingCoordinator.js").MeetingTranscriptSegment;

const t = (key: string, options: { n?: number } = {}) => {
  if (key === "notes.speaker.label") return `Speaker ${options.n}`;

  if (key === "notes.speaker.them") return "Them";

  if (key === "notes.speaker.you") return "You";

  return key;
};

const attendee = (email: string, displayName: string | null, self = false) => ({
  contactId: [...email].reduce((sum, char) => sum + char.charCodeAt(0), 1),
  email,
  displayName,
  responseStatus: null,
  self,
});

const seg = (segment: Omit<TranscriptSegment, "id" | "text" | "source">): TranscriptSegment => ({
  id: "seg",
  text: "hi",
  source: "system",
  ...segment,
});

test("mic segments carry the note owner's label", async () => {
  const { resolveLlmSpeakerLabel } = await load();
  assert.equal(
    resolveLlmSpeakerLabel(seg({ source: "mic", text: "hi" }), {}, "Alex Example", t),
    "Alex Example"
  );
  assert.equal(
    resolveLlmSpeakerLabel(
      seg({ source: "system", speaker: "you", text: "hi" }),
      {},
      "Alex Example",
      t
    ),
    "Alex Example"
  );
});

test("system segments resolve name → mapping → Speaker N → Them", async () => {
  const { resolveLlmSpeakerLabel } = await load();

  const locked = seg({
    source: "system",
    speaker: "speaker_0",
    speakerName: "Michael",
    speakerLocked: true,
    text: "hi",
  });

  assert.equal(resolveLlmSpeakerLabel(locked, { speaker_0: "Wrong" }, "You", t), "Michael");
  assert.equal(
    resolveLlmSpeakerLabel(
      seg({ source: "system", speaker: "speaker_1", text: "hi" }),
      { speaker_1: "Sean" },
      "You",
      t
    ),
    "Sean"
  );
  assert.equal(
    resolveLlmSpeakerLabel(
      seg({ source: "system", speaker: "speaker_2", text: "hi" }),
      {},
      "You",
      t
    ),
    "Speaker 3"
  );
  assert.equal(resolveLlmSpeakerLabel(seg({ source: "system", text: "hi" }), {}, "You", t), "Them");
});

test("buildLlmTranscript prefixes every line with the resolved label", async () => {
  const { buildLlmTranscript } = await load();

  const segments: TranscriptSegment[] = [
    seg({ source: "mic", text: "Morning everyone" }),
    seg({ source: "system", speaker: "speaker_0", text: "Morning" }),
  ];

  assert.equal(
    buildLlmTranscript(segments, { speaker_0: "Michael" }, "Alex", t),
    "Alex: Morning everyone\nMichael: Morning"
  );
});

test("buildMeetingContext names the owner and invited participants", async () => {
  const { buildMeetingContext } = await load();

  const identity = {
    selfName: "Alex Example",
    selfEmail: "alex@example.com",
    participants: [
      attendee("alex@example.com", "Alex Example", true),
      attendee("michael@example.com", "Michael Chen"),
      attendee("sean@example.com", null),
    ],
  };

  assert.equal(
    buildMeetingContext(identity, "Alex Example"),
    [
      "## Meeting Context",
      'The user taking these notes ("Alex Example" in the transcript) is Alex Example <alex@example.com>.',
      "Invited participants: Michael Chen <michael@example.com>, sean@example.com.",
    ].join("\n")
  );
});

test("buildMeetingContext omits what it does not know", async () => {
  const { buildMeetingContext } = await load();
  assert.equal(
    buildMeetingContext({ selfName: null, selfEmail: null, participants: [] }, "You"),
    ""
  );
  assert.equal(
    buildMeetingContext(
      { selfName: null, selfEmail: null, participants: [attendee("a@example.com", "Ada")] },
      "You"
    ),
    "## Meeting Context\nInvited participants: Ada <a@example.com>."
  );
});

test("collectKnownPeople merges owner, participants, mappings, and named segments", async () => {
  const { collectKnownPeople } = await load();

  const people = collectKnownPeople(
    {
      selfName: "Alex Example",
      selfEmail: "alex@example.com",
      participants: [
        attendee("alex@example.com", "Alex Example", true),
        attendee("michael@example.com", "Michael Chen"),
        attendee("sean@example.com", null),
      ],
    },
    { speaker_0: "Michael Chen", speaker_1: "Priya" },
    [
      {
        source: "system",
        speaker: "speaker_2",
        speakerName: "Ada",
        text: "hi",
      } as TranscriptSegment,
    ]
  );

  assert.deepEqual(people, [
    { name: "Alex Example", email: "alex@example.com", contactId: attendee("alex@example.com", "Alex Example", true).contactId },
    { name: "Michael Chen", email: "michael@example.com", contactId: attendee("michael@example.com", "Michael Chen").contactId },
    { name: "sean", email: "sean@example.com", contactId: attendee("sean@example.com", null).contactId },
    { name: "Michael Chen", email: null, contactId: null },
    { name: "Priya", email: null, contactId: null },
    { name: "Ada", email: null, contactId: null },
  ]);
});

test("LLM transcript includes the concrete platform only for an accepted platform name", async () => {
  const { buildLlmTranscript } = await load();

  const segment = seg({
    speaker: "system:guest",
    speakerName: "Guest",
    speakerLocked: true,
    speakerLockSource: "platform",
    speakerPlatform: "google-meet",
  });

  assert.equal(buildLlmTranscript([segment], {}, "You", t), "Guest [name from Google Meet]: hi");
  assert.equal(
    buildLlmTranscript([{ ...segment, speakerLockSource: "user" }], {}, "You", t),
    "Guest: hi"
  );
});

test("equal-name contacts remain distinct while duplicate IDs deduplicate", async () => {
  const { collectKnownPeople } = await load();
  const one = { contactId: 7, displayName: "Casey Synthetic", email: null, responseStatus: null, self: false };
  const people = collectKnownPeople({ selfName: null, selfEmail: null, participants: [one, one, { ...one, contactId: 8 }] }, {}, []);
  assert.deepEqual(people.map((person) => person.contactId), [7, 8]);
});
