const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const fixtureDir = path.join(root, "test/scripts/type-probes");
const selectedGroups = JSON.parse(process.env.OPENHERCULES_TYPE_PROBE_GROUPS || "[]");
let results;

function fixtures(group) {
  return fs.readdirSync(fixtureDir)
    .filter((name) => name.startsWith(`${group}-`) && /^\d+\.ts$/.test(name.slice(group.length + 1)))
    .sort()
    .map((name) => {
      const source = fs.readFileSync(path.join(fixtureDir, name), "utf8");
      const [nameLine, codesLine] = source.split("\n", 2);
      return {
        name,
        title: JSON.parse(nameLine.slice("// @probe-name ".length)),
        expected: JSON.parse(codesLine.slice("// @probe-codes ".length)),
        source,
      };
    });
}

function compile() {
  if (results) return results;
  const config = ts.readConfigFile(path.join(root, "tsconfig.main.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const records = selectedGroups.flatMap(fixtures);
  assert.ok(records.length, "selected type probes must have fixtures");
  const sources = new Map(records.map(({ name, source }) => [path.join(root, `type-probe-${name}`), source]));
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...rest) =>
    sources.has(file)
      ? ts.createSourceFile(file, sources.get(file), languageVersion, true)
      : getSourceFile(file, languageVersion, ...rest);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([...sources.keys()], { ...parsed.options, noEmit: true }, host));
  assert.deepEqual(diagnostics.filter((diagnostic) => !diagnostic.file || !sources.has(diagnostic.file.fileName)), [], "implementation graph must compile cleanly");
  results = new Map(records.map(({ name }) => {
    const file = path.join(root, `type-probe-${name}`);
    return [name, diagnostics.filter((diagnostic) => diagnostic.file?.fileName === file)
      .map((diagnostic) => diagnostic.code).sort((a, b) => a - b)];
  }));
  return results;
}

module.exports = (filename) => {
  const group = path.basename(filename, ".test.js");
  assert.ok(selectedGroups.includes(group), `Unselected type probe group: ${group}`);
  const cases = fixtures(group);
  assert.ok(cases.length, `No type probes for ${group}`);
  for (const { name, title, expected } of cases) {
    test(title, () => assert.deepEqual(compile().get(name), expected));
  }
};
