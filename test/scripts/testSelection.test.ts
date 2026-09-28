const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { validateRegistry, parseArgs, selectTests, createPlan } = require("../../scripts/test-selection");

interface Entry { file: string; domains: string[]; kind: string; buildMain: boolean; serial?: boolean }

const entries: Entry[] = [
  { file: "test/a.test.js", domains: ["notes", "calendar"], kind: "unit", buildMain: false },
  { file: "test/b.test.ts", domains: ["notes"], kind: "integration", buildMain: true },
  { file: "test/c.test.js", domains: ["ai"], kind: "unit", buildMain: false },
];
const group = { domains: ["notes"], kind: "unit", buildMain: false, files: ["test/*.test.js"] };

test("domains union and kinds intersect without duplicate execution", () => {
  const plan = selectTests(entries, parseArgs(["--domain", "calendar", "--domain", "notes", "--kind", "unit"]));
  assert.deepEqual(plan.tests.map((t: Entry) => t.file), ["test/a.test.js"]);
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
  assert.throws(() => validateRegistry(["test/a.test.js", "test/b.test.ts"], [group]), /Unclassified/);
  assert.throws(() => validateRegistry([], [group]), /Stale/);
  assert.throws(() => validateRegistry(["test/a.test.js"], [group, group]), /Duplicate/);
  assert.throws(() => validateRegistry(["test/a.test.js"], [{ ...group, kind: "fast" }]), /Invalid/);
  assert.throws(() => validateRegistry(["test/a.test.js"], [{ ...group, serial: "yes" }]), /Invalid/);
  assert.equal(validateRegistry(["test/a.test.js"], [{ ...group, serial: true }])[0].serial, true);
});

test("a new ordinary test is discovered by domain and kind without path registration", (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-test-selection-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = "test/cases/notes/unit/newBehavior.test.ts";
  fs.mkdirSync(path.join(directory, "test/cases/notes/unit"), { recursive: true });
  fs.writeFileSync(path.join(directory, file), "const test = require('node:test'); test('new behavior', () => {});\n");
  fs.writeFileSync(path.join(directory, "test/test-groups.json"), "[]\n");

  const entry = createPlan(["--domain", "notes", "--kind", "unit"], directory).tests[0];
  assert.deepEqual(entry, { file, domains: ["notes"], kind: "unit", buildMain: false, serial: false });
  assert.equal(createPlan(["--", file], directory).tests.length, 1);
  assert.throws(() => createPlan(["--domain", "calendar"], directory), /No tests/);

  const mainFile = "test/cases/platform/integration/main/emittedBridge.test.ts";
  fs.mkdirSync(path.join(directory, "test/cases/platform/integration/main"), { recursive: true });
  fs.writeFileSync(path.join(directory, mainFile), "const test = require('node:test'); test('emitted bridge', () => {});\n");
  const mainPlan = createPlan(["--domain", "platform", "--kind", "integration"], directory);
  assert.equal(mainPlan.buildMain, true);
  assert.deepEqual(mainPlan.tests.map((entry: Entry) => entry.file), [mainFile]);

  const serialFile = "test/cases/recording/integration/serial/capture.test.ts";
  fs.mkdirSync(path.join(directory, "test/cases/recording/integration/serial"), { recursive: true });
  fs.writeFileSync(path.join(directory, serialFile), "const test = require('node:test'); test('capture', () => {});\n");
  assert.equal(createPlan(["--", serialFile], directory).tests[0].serial, true);
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
  const byFile = new Map<string, Entry>(plan.tests.map((entry: Entry) => [entry.file, entry]));
  // This fixture requires the emitted WindowManager, not the test file itself.
  const devOrigin = byFile.get("test/helpers/devRendererOrigin.test.ts");
  assert.ok(devOrigin);
  assert.equal(devOrigin.buildMain, true);
  const participants = byFile.get("test/components/noteParticipantsMeetingCard.test.ts");
  assert.ok(participants);
  assert.equal(participants.domains.includes("calendar"), true);
  const selectors = byFile.get("test/helpers/settingsSelectors.test.ts");
  assert.ok(selectors);
  assert.equal(selectors.domains.includes("transcription"), true);
});
