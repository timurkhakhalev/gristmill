const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const { ESLint }: typeof import("eslint") = require("eslint");

const tseslint: typeof import("typescript-eslint") = require("typescript-eslint");

const esbuild: typeof import("esbuild") = require("esbuild");

const root = path.resolve(__dirname, "../../../..");

const renderer = path.join(root, "src");

const config = import(path.join(renderer, "eslint.config.js")) as Promise<{
  default: import("eslint").Linter.Config[];
  rendererBoundaryRules: import("eslint").Linter.RulesRecord;
  rendererSharedPolicyRoots: string[];
}>;

// Pass the actual config array explicitly: tsx's CJS interop for .js configs
// differs from the normal Node ESLint CLI loader in Electron Node mode.
const lint = config.then(
  ({ default: rules }) =>
    new ESLint({ cwd: renderer, overrideConfigFile: true, overrideConfig: rules })
);

async function messages(source: string, filePath = "components/RendererBoundaryProbe.tsx") {
  const [result] = await (await lint).lintText(source, { filePath: path.join(renderer, filePath) });
  assert.equal(
    result.messages.some((message) => /ignored|no matching configuration/i.test(message.message)),
    false,
    JSON.stringify(result.messages)
  );

  return result.messages.filter((message) => message.severity === 2);
}

test("renderer scopes permit shared policies and the preload API", async () => {
  for (const file of [
    "components/Probe.tsx",
    "components/Probe.jsx",
    "hooks/probe.ts",
    "stores/probe.ts",
    "services/probe.ts",
    "models/probe.ts",
    "lib/probe.ts",
    "lib/probe.js",
    "Probe.tsx",
  ]) {
    const prefix = file.includes("/") ? "../" : "./";
    assert.deepEqual(
      await messages(
        `import { resolveChatRoute } from "${prefix}helpers/chatRouting.js";
export const route = resolveChatRoute({ mode: "agent" });
export const read = () => window.electronAPI.getNote(1);`,
        file
      ),
      [],
      file
    );
    const errors = await messages('import "node:fs";', file);
    assert.deepEqual(
      errors.map((error) => error.ruleId),
      ["no-restricted-imports"],
      file
    );
  }
});

test("static imports, re-exports and aliases cannot reach Node or main implementation", async () => {
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
    for (const source of [`import "${specifier}";`, `export * from "${specifier}";`]) {
      assert.deepEqual(
        (await messages(source)).map((error) => error.ruleId),
        ["no-restricted-imports"],
        source
      );
    }
  }

  assert.deepEqual(
    (await messages('import type { Stats } from "node:fs"; export type FileStats = Stats;')).map(
      (error) => error.ruleId
    ),
    ["no-restricted-imports"]
  );
  assert.deepEqual(await messages('export { resolveChatRoute } from "@/helpers/chatRouting";'), []);

  for (const specifier of [
    "./localReasoningBridge",
    "./localReasoningBridge.js",
    "@/services/localReasoningBridge",
  ]) {
    assert.deepEqual(
      (await messages(`import "${specifier}";`, "services/Probe.ts")).map((error) => error.ruleId),
      ["no-restricted-imports"],
      specifier
    );
    assert.deepEqual(
      (
        await messages(`export const load = () => import("${specifier}");`, "services/Probe.ts")
      ).map((error) => error.ruleId),
      ["no-restricted-syntax"],
      specifier
    );
  }
});

test("literal dynamic imports and Node globals cannot bypass the renderer boundary", async () => {
  for (const specifier of [
    "node:fs",
    "fs/promises",
    "electron",
    "@/helpers/database.js",
    "../../main.ts",
  ]) {
    assert.deepEqual(
      (await messages(`export const load = () => import("${specifier}");`)).map(
        (error) => error.ruleId
      ),
      ["no-restricted-syntax"],
      specifier
    );
  }

  assert.deepEqual(
    await messages('export const load = () => import("@/helpers/chatRouting");'),
    []
  );

  for (const source of [
    "process.cwd()",
    'Buffer.from("text")',
    'require("fs")',
    "__dirname",
    "__filename",
    "module.exports",
    "exports.data",
  ]) {
    assert.deepEqual(
      (await messages(`export const value = ${source};`)).map((error) => error.ruleId),
      ["no-restricted-globals"],
      source
    );
  }
});

test("main-only service keeps its Node runtime requirements", async () => {
  const rules = await (
    await lint
  ).calculateConfigForFile(path.join(renderer, "services/localReasoningBridge.ts"));

  assert.equal(rules?.rules?.["no-restricted-imports"], undefined);
  assert.deepEqual(
    await messages(
      'import "node:fs"; export const directory = process.cwd();',
      "services/localReasoningBridge.ts"
    ),
    []
  );
});

// esbuild resolves the actual local runtime graph, including re-exports and
// literal dynamic imports. Packages stay external: this checks project-local
// code, not third-party package internals or arbitrary computed imports.
async function sharedGraphErrors(patch?: { file: string; source: string }) {
  const { rendererSharedPolicyRoots, rendererBoundaryRules } = await config;

  const graphLint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,mts,js}"],
        languageOptions: { parser: tseslint.parser },
        rules: rendererBoundaryRules,
      },
    ],
  });

  const graph = await esbuild.build({
    absWorkingDir: root,
    entryPoints: rendererSharedPolicyRoots,
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

  for (const entry of rendererSharedPolicyRoots)
    assert.ok(files.includes(entry), `missing graph root ${entry}`);
  assert.ok(
    files.includes("src/helpers/selfHostedTranscription.ts"),
    "transitive helper must be covered"
  );
  assert.ok(files.includes("src/utils/urlUtils.ts"), "transitive URL utility must be covered");
  const errors: Array<{ file: string; ruleId: string | null }> = [];

  for (const file of files) {
    const source =
      patch?.file === file ? patch.source : fs.readFileSync(path.join(root, file), "utf8");

    const [result] = await graphLint.lintText(source, { filePath: path.join(root, file) });
    errors.push(
      ...result.messages
        .filter((message) => message.severity === 2)
        .map((message) => ({ file, ruleId: message.ruleId }))
    );
  }

  return errors;
}

test("selected shared routing/settings graph has no local Node or main dependency", async () => {
  assert.deepEqual(await sharedGraphErrors(), []);
});

test("a Node re-export in a transitive policy dependency is rejected", async () => {
  const file = "src/helpers/selfHostedTranscription.ts";
  const source = fs.readFileSync(path.join(root, file), "utf8") + '\nexport * from "node:fs";\n';
  assert.deepEqual(await sharedGraphErrors({ file, source }), [
    { file, ruleId: "no-restricted-imports" },
  ]);
  assert.deepEqual(await sharedGraphErrors(), [], "probe must not mutate production sources");
});

test("a Node global in a transitive policy dependency is rejected", async () => {
  const file = "src/helpers/selfHostedTranscription.ts";

  const source =
    fs.readFileSync(path.join(root, file), "utf8") +
    "\nexport const nodeEnvironment = process.env.NODE_ENV;\n";

  assert.deepEqual(await sharedGraphErrors({ file, source }), [
    { file, ruleId: "no-restricted-globals" },
  ]);
});
