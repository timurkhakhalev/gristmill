const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");
const { renderStatic }: typeof import("../helpers/harness/reactSsr.ts") = require("../helpers/harness/reactSsr.ts");

const SEGMENTS = [
  { id: "s1", text: "hello from mic", source: "mic", timestamp: 1 },
  { id: "s2", text: "hi from remote", source: "system", timestamp: 2, speaker: "speaker_0" },
  { id: "s3", text: "second remote line", source: "system", timestamp: 3, speaker: "speaker_0" },
];

async function renderChat(props: Record<string, unknown>) {
  if (!i18next.isInitialized) {
    const en = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  }
  // Indirect specifier: tsc resolves a literal .tsx import and demands "jsx",
  // which tsconfig.test.json does not set; the runtime loader still gets the path.
  const chatModule: string = "../../src/components/notes/MeetingTranscriptChat.tsx";
  const mod = (await import(chatModule)) as { MeetingTranscriptChat: unknown };
  return renderStatic(mod.MeetingTranscriptChat, { segments: SEGMENTS, scrollElementRef: { current: null }, ...props });
}

test("rows resolve speaker labels through the live mappings", async () => {
  const unmapped = await renderChat({ speakerMappings: {} });
  assert.ok(unmapped.includes("Speaker 1"), "unmapped cluster shows its numbered label");

  const renamed = await renderChat({ speakerMappings: { speaker_0: "Alice" } });
  assert.ok(renamed.includes("Alice"), "renaming the cluster renames the rows");
  assert.ok(!renamed.includes("Speaker 1"));
});

test("consecutive rows of one speaker collapse the repeat label behind hover", async () => {
  const html = await renderChat({});
  // s3 follows s2 with the same effective speaker key.
  assert.equal(html.split("grid-rows-[0fr]").length - 1, 1);
});

test("reassigning the middle of one cluster renders three speaker runs", async () => {
  const segments = Array.from({ length: 6 }, (_, i) => ({
    id: `reassigned-${i}`,
    text: `line ${i}`,
    source: "system",
    timestamp: i,
    speaker: "speaker_0",
    ...(i === 2 || i === 3 ? {
      speakerName: "Bob",
      speakerLocked: true,
      speakerLockSource: "user",
      speakerStatus: "locked",
    } : {}),
  }));
  const html = await renderChat({ segments, speakerMappings: { speaker_0: "Alice" } });
  assert.equal(html.split("grid-rows-[0fr]").length - 1, 3, "one hidden repeat label per run");
  assert.ok(html.includes("Alice"));
  assert.ok(html.includes("Bob"));
});

test("selection ring follows selectedSegmentIds", async () => {
  const html = await renderChat({
    selectedSegmentIds: new Set(["s2"]),
    onToggleSelect: () => {},
  });
  assert.equal(html.split("ring-2 ring-primary/60").length - 1, 1);
});

test("a mapped profile without an email offers the add-contact affordance", async () => {
  const html = await renderChat({
    speakerMappings: { speaker_0: "Alice" },
    speakerProfiles: [{ id: 7, display_name: "Alice", email: null }],
    onAttachSpeakerEmail: () => {},
  });
  assert.ok(html.includes("Add contact"));

  const withEmail = await renderChat({
    speakerMappings: { speaker_0: "Alice" },
    speakerProfiles: [{ id: 7, display_name: "Alice", email: "alice@example.com" }],
    onAttachSpeakerEmail: () => {},
  });
  assert.ok(!withEmail.includes("Add contact"));
});

test("a long transcript initially renders only a window of rows", async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({
    id: `m${i}`,
    text: `line ${i}`,
    source: "system",
    timestamp: i,
    speaker: `speaker_${i % 3}`,
  }));
  const html = await renderChat({ segments: many });

  const rendered = html.split("data-index=").length - 1;
  assert.ok(rendered > 0, "the first screenful renders before the scroller is measured");
  assert.ok(rendered < 60, `expected a window, got ${rendered} of 500 rows`);
  assert.equal(html.split("agent-message-in").length - 1, 0, "older rows in the initial window do not animate");
});

test("only the newest settled row receives the entrance animation", async () => {
  const segments = Array.from({ length: 4 }, (_, i) => ({
    id: `animation-${i}`,
    text: `line ${i}`,
    source: "system",
    timestamp: i,
    speaker: "speaker_0",
  }));
  const html = await renderChat({ segments });
  assert.equal(html.split("agent-message-in 200ms").length - 1, 1);
});

test("live partials render alongside the settled rows", async () => {
  const html = await renderChat({ micPartial: "still talking" });
  assert.ok(html.includes("still talking"));
  assert.ok(html.includes("hello from mic"));
});
