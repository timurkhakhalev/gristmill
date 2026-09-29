const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const {
  replaceMeetingRecap,
  replaceMeetingTasks,
  validateMeetingRecap,
  validateMeetingTasks,
}: typeof import("../../../../src/helpers/meetingSummarySections.ts") = require("../../../../src/helpers/meetingSummarySections.ts");

test("prioritized tasks require exact keys, bounded nonempty strings and no duplicates", () => {
  assert.deepEqual(validateMeetingTasks(JSON.stringify({
    HIGH: ["Ship release"], MEDIUM: ["Review tests"], LOW: [],
  })), {
    success: true,
    value: { HIGH: ["Ship release"], MEDIUM: ["Review tests"], LOW: [] },
  });
  for (const input of [
    { HIGH: [""], MEDIUM: [], LOW: [] },
    { HIGH: ["same"], MEDIUM: [" Same "], LOW: [] },
    { HIGH: ["a", "b", "c", "d"], MEDIUM: [], LOW: [] },
    { HIGH: [], MEDIUM: [], LOW: [], extra: [] },
  ]) {
    assert.equal(validateMeetingTasks(JSON.stringify(input)).success, false);
  }
});

test("task mutation replaces only the final Action Items section and zero tasks remove it", () => {
  const initial = "## TLDR\nKeep this summary.\n\n## Action Items\n\n- Old task\n";
  const replacement = replaceMeetingTasks(initial, {
    HIGH: ["Ship the release"], MEDIUM: [], LOW: ["Review the notes"],
  });
  assert.equal(replacement.success, true);
  if (!replacement.success) return;
  assert.equal(replacement.markdown, "## TLDR\nKeep this summary.\n\n## Action Items\n\n### HIGH\n\n- Ship the release\n\n### LOW\n\n- Review the notes");

  const recap = replaceMeetingRecap(replacement.markdown, { title: "Release", bullets: ["Ship Friday"] });
  assert.equal(recap.success, true);
  if (!recap.success) return;
  assert.match(recap.markdown, /## Action Items[\s\S]*## Recap/);
  assert.match(recap.markdown, /\*\*Release\*\*/);

  const zero = replaceMeetingTasks(recap.markdown, { HIGH: [], MEDIUM: [], LOW: [] });
  assert.equal(zero.success, true);
  if (!zero.success) return;
  assert.doesNotMatch(zero.markdown, /## Action Items/);
  assert.match(zero.markdown, /## TLDR[\s\S]*## Recap/);
});

test("nonempty tasks refuse absent, ambiguous, or nonfinal Action Items headings", () => {
  const tasks = { HIGH: ["Do the task"], MEDIUM: [], LOW: [] };
  for (const markdown of [
    "## TLDR\nSummary.",
    "## Action Items\n\n- first\n\n## Topic\nText.",
    "## Action Items\n\n- one\n\n## Action Items\n\n- two",
    "## Action Items\n\n- one\n\n## Topic\nText.\n\n## Recap\nEnd.",
  ]) {
    const result = replaceMeetingTasks(markdown, tasks);
    assert.deepEqual(result, { success: false, error: "meeting-summary-section-invalid" });
  }
});

test("Recap validation counts Unicode code points and rejects multiline or empty values", () => {
  assert.equal(validateMeetingRecap(JSON.stringify({ title: "😀".repeat(58), bullets: [] })).success, true);
  for (const input of [
    { title: "😀".repeat(59), bullets: [] },
    { title: "Title", bullets: [" "] },
    { title: "Title", bullets: ["first\nsecond"] },
    { title: "Title", bullets: ["x".repeat(89)] },
    { title: "Title", bullets: [], extra: true },
  ]) {
    assert.equal(validateMeetingRecap(JSON.stringify(input)).success, false);
  }
});
