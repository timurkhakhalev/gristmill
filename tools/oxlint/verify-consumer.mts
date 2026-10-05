import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { z } from "zod";

const root = fileURLToPath(new URL("../../", import.meta.url));

const binary = path.join(root, "node_modules/.bin/oxlint");

const configSchema = z.looseObject({
  extends: z.array(z.string()),
  jsPlugins: z.array(z.object({ name: z.string(), specifier: z.string() })),
  overrides: z.array(
    z.looseObject({ files: z.array(z.string()), rules: z.record(z.string(), z.unknown()) })
  ),
});

const outputSchema = z.object({
  number_of_files: z.number(),
  diagnostics: z.array(z.object({ code: z.string().optional() })),
});

await test("project consumer preserves type, Promise and runtime boundary rules", (t) => {
  const consumer = mkdtempSync(path.join(tmpdir(), "gristmill-oxlint-consumer-"));
  t.after(() => rmSync(consumer, { recursive: true, force: true }));
  symlinkSync(path.join(root, "node_modules"), path.join(consumer, "node_modules"), "dir");
  // The bundle and plugin dirs must exist at their documented relative
  // locations as real directories; symlinks or missing pieces change how
  // oxlint resolves the plugin graph and drift type-aware results.
  mkdirSync(path.join(consumer, "tools/typescript-quality/plugin"), { recursive: true });
  cpSync(
    path.join(root, "tools/typescript-quality/plugin"),
    path.join(consumer, "tools/typescript-quality/plugin"),
    { recursive: true }
  );
  cpSync(
    path.join(root, "tools/typescript-quality/.oxlintrc.json"),
    path.join(consumer, "tools/typescript-quality/.oxlintrc.json")
  );
  cpSync(
    path.join(root, "tools/oxlint/critical-write.mts"),
    path.join(consumer, "tools/oxlint/critical-write.mts"),
    { recursive: true }
  );
  writeFileSync(path.join(consumer, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      extends: path.join(root, "tsconfig.test.json"),
      compilerOptions: { rootDir: ".", noEmit: true },
      include: ["**/*.ts", "**/*.mts"],
      exclude: [],
    })
  );

  const configuration = configSchema.parse(
    JSON.parse(readFileSync(path.join(root, ".oxlintrc.json"), "utf8"))
  );

  // configuration keeps the documented relative extends; the bundle above is
  // copied so the resolution graph matches a real consumer checkout.
  writeFileSync(path.join(consumer, ".oxlintrc.json"), JSON.stringify(configuration));

  const write = (file: string, source: string) => {
    mkdirSync(path.dirname(path.join(consumer, file)), { recursive: true });
    writeFileSync(path.join(consumer, file), source);
  };

  const run = (file: string, tsconfig?: string) => {
    const args = ["-c", ".oxlintrc.json", "--format", "json", path.join(consumer, file)];

    if (tsconfig) args.push("--type-aware", "--tsconfig", tsconfig);
    const child = spawnSync(binary, args, { cwd: consumer, encoding: "utf8" });
    assert.ifError(child.error);
    const output = outputSchema.parse(JSON.parse(child.stdout));
    assert.equal(output.number_of_files, 1, child.stdout);

    return output.diagnostics.map((diagnostic) => diagnostic.code ?? "unidentified");
  };

  const valid =
    'export function isNumber(value: string | number): value is number {\n  return typeof value === "number";\n}\n\nexport const state = "ready" as const;\n';

  for (const [file, program] of [
    ["src/helpers/probe.ts", "tsconfig.main.json"],
    ["src/hooks/probe.ts", "src/tsconfig.json"],
    ["test/probe.ts", "tsconfig.test.json"],
    ["scripts/probe.mts", "tsconfig.scripts.json"],
    ["extension/src/probe.ts", "extension/tsconfig.json"],
  ]) {
    const config = path.join(path.dirname(file), "tsconfig.json");
    write(
      config,
      JSON.stringify({
        extends: path.join(root, program),
        compilerOptions: { rootDir: ".", noEmit: true },
        include: [path.basename(file)],
        exclude: [],
      })
    );
    write(file, valid);
    assert.deepEqual(run(file), [], file);
    write(file, "export const value = ({} as unknown as { id: number })!;\n");
    assert.ok(run(file).includes("quality(no-chained-type-assertions)"), file);

    write(file, "export async function save(): Promise<void> {}\n\nvoid save();\n");
    assert.ok(run(file, config).includes("typescript(no-floating-promises)"), file);
  }

  write(
    "src/tsconfig.json",
    JSON.stringify({
      extends: path.join(root, "src/tsconfig.json"),
      compilerOptions: { rootDir: ".", noEmit: true },
      include: ["**/*.ts"],
      exclude: [],
    })
  );

  for (const source of [
    'export * from "../helpers/chatRouting.js";',
    'export * from "@/helpers/transcriptionRoute";',
    'export const load = () => import("@/helpers/chatRouting");',
  ]) {
    write("src/services/probe.ts", source);
    assert.deepEqual(run("src/services/probe.ts"), [], source);
  }

  for (const [file, source, expected] of [
    ["src/services/probe.ts", 'import "node:fs";', "eslint(no-restricted-imports)"],
    [
      "src/services/probe.ts",
      'export const load = () => import("./localReasoningBridge");',
      "eslint(no-restricted-imports)",
    ],
    ["extension/src/probe.ts", 'import "os";', "eslint(no-restricted-imports)"],
    ["src/services/probe.ts", 'import "../helpers/database.js";', "eslint(no-restricted-imports)"],
    [
      "src/hooks/probe.ts",
      "await window.electronAPI?.updateNote(1, {});",
      "gristmill(no-discarded-critical-write)",
    ],
  ]) {
    write(file, source);
    assert.ok(run(file).includes(expected), file);
  }

  const parser =
    'export function isString(value: unknown): value is string {\n  return typeof value === "string";\n}\n\nexport function parse(value: unknown): string {\n  if (isString(value)) return value;\n\n  throw new Error("Expected string");\n}\n';

  write("src/helpers/boundary.ts", parser);
  assert.ok(run("src/helpers/boundary.ts").includes("quality(no-unknown-parameters)"));
  configuration.overrides.push({
    files: ["**/src/helpers/boundary.ts"],
    rules: { "quality/no-unknown-parameters": "off" },
  });
  write(".oxlintrc.json", JSON.stringify(configuration));
  assert.deepEqual(run("src/helpers/boundary.ts"), []);
  write("src/helpers/other.ts", parser);
  assert.ok(run("src/helpers/other.ts").includes("quality(no-unknown-parameters)"));

  // node:test top-level policy: there is no blanket test exception. The
  // shared harness observes each registration promise through a catch handler
  // (test/lib helpers do the same), so an observed registration stays allowed,
  // while an unawaited subtest and a plain unhandled Promise are flagged.
  write(
    "test/tsconfig.json",
    JSON.stringify({
      extends: path.join(root, "tsconfig.test.json"),
      compilerOptions: { rootDir: ".", noEmit: true },
      include: ["*.ts"],
      exclude: [],
    })
  );

  // node:test top-level policy: there is no blanket test exception. The
  // shared harness observes each registration promise through a catch handler
  // (test/lib helpers do the same), so an observed registration stays allowed,
  // while an unawaited subtest and a plain unhandled Promise are flagged.
  const observedRegistration =
    'import test from "node:test";\n\ntest("root case", async () => {}).catch((error: Error) => {\n  throw error;\n});\n';

  write("test/registration.ts", observedRegistration);
  assert.deepEqual(
    run("test/registration.ts", "test/tsconfig.json"),
    [],
    "observed node:test registration must stay allowed"
  );

  const unawaitedSubtest =
    'import test from "node:test";\n\ntest("outer", (t) => {\n  t.test("dropped", async () => {});\n});\n';

  write("test/unawaited-subtest.ts", unawaitedSubtest);
  assert.ok(
    run("test/unawaited-subtest.ts", "test/tsconfig.json").includes(
      "typescript(no-floating-promises)"
    ),
    "unawaited subtest must be flagged"
  );

  const unhandledPromise = "Promise.resolve().then(() => {});\n";
  write("test/unhandled-promise.ts", unhandledPromise);
  assert.ok(
    run("test/unhandled-promise.ts", "test/tsconfig.json").includes(
      "typescript(no-floating-promises)"
    ),
    "plain unhandled Promise must be flagged"
  );
});
