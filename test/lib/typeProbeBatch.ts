import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as test from "node:test";
import ts from "typescript";

const root = path.resolve(__dirname, "../..");

const fixtureDir = path.join(root, "test/scripts/type-probes");

// SAFETY: the runner serializes this env var from its own string array; the
// assertion types the JSON round-trip for local filtering only.
const selectedGroups: string[] = JSON.parse(
  process.env.GRISTMILL_TYPE_PROBE_GROUPS ?? "[]"
) as string[];

let results: Map<string, number[]> | undefined;

interface FixtureRecord {
  name: string;
  title: string;
  expected: number[];
  source: string;
}

function fixtures(group: string): FixtureRecord[] {
  return fs
    .readdirSync(fixtureDir)
    .filter(
      (name) => name.startsWith(`${group}-`) && /^\d+\.ts$/.test(name.slice(group.length + 1))
    )
    .sort()
    .map((name) => {
      const source = fs.readFileSync(path.join(fixtureDir, name), "utf8");
      const [nameLine, codesLine] = source.split("\n", 2);

      if (!nameLine || !codesLine) throw new Error(`Missing probe header in ${name}`);

      // SAFETY: the header format is this repo's own fixture contract; the
      // assertions pin the JSON round-trip to the documented value types.
      return {
        name,
        title: JSON.parse(nameLine.slice("// @probe-name ".length)) as string,
        expected: JSON.parse(codesLine.slice("// @probe-codes ".length)) as number[],
        source,
      };
    });
}

function compile(): Map<string, number[]> {
  if (results) return results;
  const config = ts.readConfigFile(path.join(root, "tsconfig.main.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const records = selectedGroups.flatMap(fixtures);
  assert.ok(records.length, "selected type probes must have fixtures");

  const sources = new Map(
    records.map(({ name, source }) => [path.join(root, `type-probe-${name}`), source])
  );

  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file: string, languageVersion: ts.ScriptTarget, ...rest: never[]) => {
    const overridden = sources.get(file);

    if (overridden !== undefined) {
      return ts.createSourceFile(file, overridden, languageVersion, true);
    }

    return getSourceFile(file, languageVersion, ...rest);
  };

  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram([...sources.keys()], { ...parsed.options, noEmit: true }, host)
  );

  assert.deepEqual(
    diagnostics.filter((diagnostic) => !diagnostic.file || !sources.has(diagnostic.file.fileName)),
    [],
    "implementation graph must compile cleanly"
  );
  results = new Map(
    records.map(({ name }) => {
      const file = path.join(root, `type-probe-${name}`);

      return [
        name,
        diagnostics
          .filter((diagnostic) => diagnostic.file?.fileName === file)
          .map((diagnostic) => diagnostic.code)
          .sort((a, b) => a - b),
      ];
    })
  );

  return results;
}

function runTypeProbeBatch(filename: string): void {
  const group = path.basename(filename).replace(/\.test\.(js|ts)$/, "");
  assert.ok(selectedGroups.includes(group), `Unselected type probe group: ${group}`);
  const cases = fixtures(group);
  assert.ok(cases.length, `No type probes for ${group}`);

  for (const { name, title, expected } of cases) {
    test
      .test(title, () => assert.deepEqual(compile().get(name), expected))
      .catch((error: Error) => {
        throw error;
      });
  }
}

export default runTypeProbeBatch;
