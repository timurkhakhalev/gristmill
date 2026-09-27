const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { validateRegistry, parseArgs, selectTests, createPlan } = require("../../scripts/test-selection");

const entries = [
  { file: "test/a.test.js", domains: ["notes", "calendar"], kind: "unit", buildMain: false },
  { file: "test/b.test.ts", domains: ["notes"], kind: "integration", buildMain: true },
  { file: "test/c.test.js", domains: ["ai"], kind: "unit", buildMain: false },
];
const group = { domains: ["notes"], kind: "unit", buildMain: false, files: ["test/*.test.js"] };

test("domains union and kinds intersect without duplicate execution", () => {
  const plan = selectTests(entries, parseArgs(["--domain", "calendar", "--domain", "notes", "--kind", "unit"]));
  assert.deepEqual(plan.tests.map((t) => t.file), ["test/a.test.js"]);
  assert.equal(plan.buildMain, false);
  assert.equal(selectTests(entries, parseArgs(["--domain", "notes"])).buildMain, true);
  assert.equal(selectTests(entries, parseArgs(["--kind", "unit", "--kind", "integration"])).tests.length, 3);
});

test("full selection and explicit files are complete and deterministic", () => {
  assert.deepEqual(selectTests(entries, parseArgs([])).tests, entries);
  assert.equal(selectTests(entries, parseArgs(["--", "test/a.test.js", "test/a.test.js"])).tests.length, 1);
});

test("invalid, ambiguous and empty selections fail closed", () => {
  for (const args of [["--domain"], ["--domain", "calendr"], ["--kind", "fast"], ["--watch"], ["--processes"], ["--processes", "3"], ["--domain", "notes", "test/a.test.js"], ["--", "--", "test/a.test.js"]]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(["--processes", "2"]).processes, 2);
  assert.equal(parseArgs([]).processes, 2);
  assert.throws(() => selectTests(entries, parseArgs(["test/missing.test.js"])), /Unknown test file/);
  assert.throws(() => selectTests(entries, parseArgs(["--domain", "ai", "--kind", "native"])), /No tests/);
});

test("registry catches missing, stale, duplicate and invalid registrations", () => {
  assert.equal(validateRegistry(["test/a.test.js"], [group]).length, 1);
  assert.throws(() => validateRegistry(["test/a.test.js", "test/b.test.ts"], [group]), /Unregistered/);
  assert.throws(() => validateRegistry([], [group]), /Stale/);
  assert.throws(() => validateRegistry(["test/a.test.js"], [group, group]), /Duplicate/);
  assert.throws(() => validateRegistry(["test/a.test.js"], [{ ...group, kind: "fast" }]), /Invalid/);
  assert.throws(() => validateRegistry(["test/a.test.js"], [{ ...group, serial: "yes" }]), /Invalid/);
  assert.equal(validateRegistry(["test/a.test.js"], [{ ...group, serial: true }])[0].serial, true);
});

test("repository registry covers every test and compiled-output consumers request a build", () => {
  const plan = createPlan([]);
  const root = path.resolve(__dirname, "../..");
  for (const entry of plan.tests) {
    // This test inspects sources without loading compiled output.
    if (path.join(root, entry.file) === __filename) continue;
    if (fs.readFileSync(path.join(root, entry.file), "utf8").includes("dist-main")) {
      assert.equal(entry.buildMain, true, entry.file);
    }
  }
  const byFile = new Map(plan.tests.map((entry) => [entry.file, entry]));
  // This fixture requires the emitted WindowManager, not the test file itself.
  assert.equal(byFile.get("test/helpers/devRendererOrigin.test.js").buildMain, true);
  assert.equal(byFile.get("test/components/noteParticipantsMeetingCard.test.js").domains.includes("calendar"), true);
  assert.equal(byFile.get("test/helpers/settingsSelectors.test.js").domains.includes("transcription"), true);
});
