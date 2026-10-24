const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const fsp: typeof import("node:fs/promises") = require("node:fs/promises");

const path: typeof import("node:path") = require("node:path");

const esbuild: typeof import("esbuild") = require("esbuild");

const root = path.resolve(__dirname, "../../../..");

// The renderer graph probes run the real project Oxlint config over real and
// synthetic files so the boundary rules and the test exclusion stay honest.
let sequence = 0;

const probePaths: string[] = [];

test.afterEach(async () => {
  for (const file of probePaths.splice(0)) await fsp.rm(file, { force: true });
});

function probePathSync(directory: string, source: string): string {
  const file = path.join(root, directory, `BoundaryProbe${++sequence}.ts`);
  probePaths.push(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);

  return file;
}

interface Diagnostic {
  code?: string;
}

async function lintFiles(files: string[]): Promise<Map<string, string[]>> {
  const child = require("node:child_process").spawnSync(
    path.join(root, "node_modules/.bin/oxlint"),
    ["--format", "json", ...files],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(child.error, undefined, String(child.error));

  const start = (child.stdout as string).indexOf("{");
  assert.notEqual(start, -1, `no lint JSON: ${child.stdout}${child.stderr}`);

  const output = JSON.parse((child.stdout as string).slice(start)) as {
    number_of_files?: number;
    diagnostics: Array<{ code?: string; filename: string }>;
  };

  // oxlint reports paths relative to the config root; key both ways so the
  // absolute probe targets and the relative graph files both resolve.
  const byFile = new Map<string, string[]>();
  const record = (key: string, code: string) => {
    const codes = byFile.get(key) ?? [];
    codes.push(code);
    byFile.set(key, codes);
  };

  for (const diagnostic of output.diagnostics) {
    const code = diagnostic.code ?? "unidentified";
    record(diagnostic.filename, code);
    record(path.resolve(root, diagnostic.filename), code);
  }

  return byFile;
}


interface ProbeCase {
  label: string;
  file: string;
  source: string;
  codes: string[] | null;
  contains?: string;
}

interface Plan {
  cases: ProbeCase[];
}

const plan = (): Plan => ({ cases: [] });

function expectProbe(
  p: Plan,
  label: string,
  directory: string,
  source: string,
  codes: string[] | null
): void {
  p.cases.push({ label, file: probePathSync(path.join("src", directory), source), source, codes });
}

// One oxlint spawn per plan: per-case spawns would exceed the 30s suite
// timeout. A case with null codes only requires the file to lint without
// unexpected noise from other rules; assertPlanReports checks the rest.
async function runPlan(p: Plan): Promise<void> {
  const byFile = await lintFiles(p.cases.map((item) => item.file));

  for (const item of p.cases) {
    const actual = byFile.get(item.file) ?? [];

    if (item.codes !== null) assert.deepEqual(actual, item.codes, item.label);

    if (item.contains) assert.ok(actual.includes(item.contains), item.label);
  }
}

test("renderer scopes permit shared policies and the preload API", async () => {
  const p = plan();

  for (const directory of ["components", "hooks", "stores", "services", "models", "lib"]) {
    expectProbe(
      p,
      directory,
      directory,
      `import { resolveChatRoute } from "../helpers/chatRouting.js";

export const route = resolveChatRoute({ mode: "agent" });

export const read = () => window.electronAPI.getNote(1);
`,
      []
    );
    expectProbe(p, directory, directory, 'import "node:fs";\n', ["eslint(no-restricted-imports)"]);
  }

  await runPlan(p);
});

test("static imports, re-exports and aliases cannot reach Node or main implementation", async () => {
  const p = plan();

  for (const specifier of [
    "fs",
    "fs/promises",
    "node:sqlite",
    "electron",
    "electron/renderer",
    "child_process",
    "../helpers/database.js",
    "@/helpers/ipcHandlers",
    "../helpers/debugLogger.ts",
    "../utils/serverUtils",
    "@/utils/process.js",
    "../preload/notesBridge",
    "../workers/onnxWorker",
    "../services/localReasoningBridge",
    "../../main.ts",
    "../../preload.ts",
  ]) {
    for (const source of [`import "${specifier}";\n`, `export * from "${specifier}";\n`]) {
      expectProbe(p, source, "components", source, ["eslint(no-restricted-imports)"]);
    }
  }

  expectProbe(
    p,
    "type import",
    "components",
    'import type { Stats } from "node:fs";\n\nexport type FileStats = Stats;\n',
    ["eslint(no-restricted-imports)"]
  );
  expectProbe(
    p,
    "shared re-export",
    "components",
    'export { resolveChatRoute } from "@/helpers/chatRouting";\n',
    []
  );

  for (const specifier of [
    "./localReasoningBridge",
    "./localReasoningBridge.js",
    "@/services/localReasoningBridge",
  ]) {
    expectProbe(
      p,
      `import ${specifier}`,
      "services",
      `import "${specifier}";\n`,
      ["eslint(no-restricted-imports)"]
    );
    expectProbe(
      p,
      `dynamic ${specifier}`,
      "services",
      `export const load = () => import("${specifier}");\n`,
      ["eslint(no-restricted-imports)"]
    );
  }

  await runPlan(p);
});

test("literal dynamic imports and Node globals cannot bypass the renderer boundary", async () => {
  const p = plan();

  for (const specifier of ["node:fs", "fs/promises", "electron", "@/helpers/database.js", "../../main.ts"]) {
    expectProbe(
      p,
      specifier,
      "components",
      `export const load = () => import("${specifier}");\n`,
      ["eslint(no-restricted-imports)"]
    );
  }

  expectProbe(
    p,
    "allowed dynamic import",
    "components",
    'export const load = () => import("@/helpers/chatRouting");\n',
    []
  );

  for (const source of [
    "process.cwd()",
    'Buffer.from("text")',
    "__dirname",
    "__filename",
  ]) {
    expectProbe(
      p,
      source,
      "components",
      `export const value = ${source};\n`,
      ["eslint(no-restricted-globals)"]
    );
  }

  // require and the CJS export globals also carry the unsafe-assignment rule
  // on the same assignment; the boundary trip is what this probe pins.
  for (const source of ['require("fs")', "module.exports", "exports.data"]) {
    expectProbe(p, source, "components", `export const value = ${source};\n`, null);
    p.cases.at(-1)!.contains = "eslint(no-restricted-globals)";
  }

  await runPlan(p);
});

test("main-only service keeps its Node runtime requirements", async () => {
  const bridge = path.join(root, "src/services/localReasoningBridge.ts");
  const byFile = await lintFiles([bridge]);

  // The bridge has its own override and must stay clean under the real config.
  assert.deepEqual(byFile.get(bridge) ?? [], []);

  const p = plan();
  expectProbe(
    p,
    "services scope still bounds non-bridge files",
    "services",
    'import "node:fs";\n\nexport const directory = process.cwd();\n',
    ["eslint(no-restricted-imports)", "eslint(no-restricted-globals)"]
  );

  await runPlan(p);
});

// esbuild resolves the actual local runtime graph, including re-exports and
// literal dynamic imports. Packages stay external: this checks project-local
// code, not third-party package internals or arbitrary computed imports.
async function sharedGraphErrors(patch?: { file: string; source: string }) {
  const roots = [
    "src/config/settingsSelectors.ts",
    "src/helpers/chatRouting.ts",
    "src/helpers/transcriptionRoute.ts",
  ];

  const graph = await esbuild.build({
    absWorkingDir: root,
    entryPoints: roots,
    bundle: true,
    platform: "browser",
    packages: "external",
    write: false,
    metafile: true,
    outdir: "unused-renderer-policy-output",
    logLevel: "silent",
    plugins: patch
      ? [
          {
            name: "owned-source-probe",
            setup(build) {
              build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
                if (args.path !== path.join(root, patch.file)) return;

                return { contents: patch.source, loader: "ts" };
              });
            },
          },
        ]
      : [],
  });

  const files = Object.keys(graph.metafile!.inputs).filter(
    (file) => file.startsWith("src/") && /\.[cm]?[jt]sx?$/.test(file)
  );

  for (const entry of roots) assert.ok(files.includes(entry), `missing graph root ${entry}`);
  assert.ok(
    files.includes("src/helpers/selfHostedTranscription.ts"),
    "transitive helper must be covered"
  );
  assert.ok(files.includes("src/utils/endpointPolicy.ts"), "transitive URL utility must be covered");

  // Write patched inputs next to their real location so the boundary override
  // globs match exactly; unpatched graph files are linted in place.
  const lintTargets: string[] = [];

  for (const file of files) {
    if (patch?.file === file) {
      // Probe lives under a boundary-covered directory (services/**) because
      // helpers/** has no import/globals restriction of its own; the codes,
      // not the file paths, are the assertion.
      lintTargets.push(probePathSync("src/services", patch.source));
    } else {
      lintTargets.push(path.join(root, file));
    }
  }

  const byFile = await lintFiles(lintTargets);

  // The map keys each diagnostic under both its relative and absolute path;
  // the assertion is the set of codes, not their per-path multiplicity.
  return [...new Set([...byFile.values()].flat())].map((code) =>
    code.replace(/^eslint\./, "")
  );

}

test("selected shared routing/settings graph has no local Node or main dependency", async () => {
  assert.deepEqual(await sharedGraphErrors(), []);
});

test("a Node re-export in a transitive policy dependency is rejected", async () => {
  const file = "src/helpers/selfHostedTranscription.ts";
  const source = fs.readFileSync(path.join(root, file), "utf8") + '\nexport * from "node:fs";\n';
  assert.deepEqual(await sharedGraphErrors({ file, source }), ["eslint(no-restricted-imports)"]);
  assert.deepEqual(await sharedGraphErrors(), [], "probe must not mutate production sources");
});

test("a Node global in a transitive policy dependency is rejected", async () => {
  const file = "src/helpers/selfHostedTranscription.ts";

  const source =
    fs.readFileSync(path.join(root, file), "utf8") +
    "\nexport const nodeEnvironment = process.env.NODE_ENV;\n";

  assert.deepEqual(await sharedGraphErrors({ file, source }), ["eslint(no-restricted-globals)"]);
});
