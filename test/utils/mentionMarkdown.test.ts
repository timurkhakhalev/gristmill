const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/utils/mentionMarkdown.js");

const PEOPLE = [
  { name: "Alex Example", email: "alex@example.com", contactId: 1 },
  { name: "Michael Chen", email: "michael@example.com", contactId: 2 },
  { name: "Sean", email: null, contactId: 3 },
];

test("buildMentionMarkdown links the stable ID when an email is present", async () => {
  const { buildMentionMarkdown } = await load();
  assert.equal(
    buildMentionMarkdown({ name: "Michael Chen", email: "michael@example.com", contactId: 2 }),
    "[@Michael Chen](mention:contact:2)"
  );
});

test("unbound mention text keeps readable names without inventing a contact link", async () => {
  const { buildMentionMarkdown } = await load();
  assert.equal(buildMentionMarkdown({ name: "Sean", email: null, contactId: null }), "@Sean");
  // Parens would end the markdown link destination early; brackets break the label.
  assert.equal(
    buildMentionMarkdown({ name: "Ana (PM)", email: null, contactId: null }),
    "@Ana (PM)"
  );
  assert.equal(
    buildMentionMarkdown({ name: "Bob [ops]", email: null, contactId: null }),
    "@Bob ops"
  );
});

test("parseMentionEmail extracts emails and rejects everything else", async () => {
  const { parseMentionEmail } = await load();
  assert.equal(parseMentionEmail("mention:michael%40example.com"), "michael@example.com");
  assert.equal(parseMentionEmail("mention:Sean"), null);
  assert.equal(parseMentionEmail("https://example.com"), null);
  assert.equal(parseMentionEmail(null), null);
  assert.equal(parseMentionEmail("mention:%E0%A4%A"), null);
});

test("tags a full-name owner on a checkbox line", async () => {
  const { tagActionItemOwners } = await load();
  assert.equal(
    tagActionItemOwners("- [ ] Send the deck — Michael Chen", PEOPLE),
    "- [ ] Send the deck — [@Michael Chen](mention:contact:2)"
  );
});

test("tags by unique first name, case-insensitively", async () => {
  const { tagActionItemOwners } = await load();
  assert.equal(
    tagActionItemOwners("- [x] Review PR - michael", PEOPLE),
    "- [x] Review PR - [@Michael Chen](mention:contact:2)"
  );
});

test("leaves ambiguous first names untouched", async () => {
  const { tagActionItemOwners } = await load();

  const people = [
    { name: "Michael Chen", email: "michael@example.com", contactId: 2 },
    { name: "Michael Ross", email: "mross@example.com", contactId: 6 },
  ];

  const line = "- [ ] Review PR — Michael";
  assert.equal(tagActionItemOwners(line, people), line);
});

test("tags multiple owners only when every owner is known", async () => {
  const { tagActionItemOwners } = await load();
  assert.equal(
    tagActionItemOwners("- [ ] Draft the plan — Sean and Michael", PEOPLE),
    "- [ ] Draft the plan — [@Sean](mention:contact:3), [@Michael Chen](mention:contact:2)"
  );
  const partiallyUnknown = "- [ ] Draft the plan — Sean and Priya";
  assert.equal(tagActionItemOwners(partiallyUnknown, PEOPLE), partiallyUnknown);
});

test("ignores unknown owners, non-task lines, and already-tagged lines", async () => {
  const { tagActionItemOwners } = await load();
  const unknown = "- [ ] Follow up — Priya";
  assert.equal(tagActionItemOwners(unknown, PEOPLE), unknown);

  const prose = "We agreed — Michael will follow up.";
  assert.equal(tagActionItemOwners(prose, PEOPLE), prose);

  const tagged = "- [ ] Send the deck — [@Michael Chen](mention:contact:2)";
  assert.equal(tagActionItemOwners(tagged, PEOPLE), tagged);
});

test("handles multi-line markdown and empty people", async () => {
  const { tagActionItemOwners } = await load();
  const markdown = ["## Action Items", "- [ ] Ship it — Sean", "- [ ] Untouched text"].join("\n");
  assert.equal(
    tagActionItemOwners(markdown, PEOPLE),
    ["## Action Items", "- [ ] Ship it — [@Sean](mention:contact:3)", "- [ ] Untouched text"].join("\n")
  );
  assert.equal(tagActionItemOwners(markdown, []), markdown);
});

test("positive ID parsing rejects malformed IDs and names never guess contacts", async () => {
  const { parseMentionContactId, tagActionItemOwners, buildMentionMarkdown } = await load();
  assert.equal(parseMentionContactId("mention:contact:7"), 7);
  for (const href of ["mention:contact:0", "mention:contact:-1", "mention:contact:1.5", "mention:contact:01", "mention:contact:9007199254740992", "mention:label", "mention:%oops"]) assert.equal(parseMentionContactId(href), null);
  assert.equal(buildMentionMarkdown({ name: "Unbound Sample", email: "unbound@example.com", contactId: null }), "@Unbound Sample");
  const twins = [{ name: "Casey Synthetic", email: null, contactId: 7 }, { name: "Casey Synthetic", email: null, contactId: 8 }];
  for (const owner of ["Casey Synthetic", "Casey"]) assert.equal(tagActionItemOwners(`- [ ] Review — ${owner}`, twins), `- [ ] Review — ${owner}`);
});
