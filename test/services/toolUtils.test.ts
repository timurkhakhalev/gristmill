const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const ts = require("typescript");

type UtilsModule = typeof import("../../src/services/tools/utils.js");

let loaded: Promise<UtilsModule> | undefined;

const load = () => {
  if (!loaded) {
    const filename = path.join(__dirname, "../../src/services/tools/utils.ts");
    const source = fs.readFileSync(filename, "utf8");

    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;

    loaded = import(
      `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
    ) as Promise<UtilsModule>;
  }

  return loaded;
};

const setWindow = (value: unknown) => {
  (globalThis as { window?: unknown }).window = value;
};

test("resolveFolderId normalizes whitespace and matches existing folders case-insensitively", async () => {
  const { resolveFolderId } = await load();
  setWindow({
    electronAPI: {
      getFolders: async () => [{ id: 10, name: "Work" }],
      createFolder: async () => ({ success: true, folder: { id: 20, name: "NewFolder" } }),
    },
  });

  const match = await resolveFolderId("  work  ");
  assert.deepEqual(match, { folderId: 10, created: false });
});

test("resolveFolderId trims folder name before creating missing folders", async () => {
  const { resolveFolderId } = await load();
  let createdName: string | null = null;
  setWindow({
    electronAPI: {
      getFolders: async () => [],
      createFolder: async (name: string) => {
        createdName = name;

        return { success: true, folder: { id: 15, name } };
      },
    },
  });

  const res = await resolveFolderId("  Projects  ", { createIfMissing: true });
  assert.deepEqual(res, { folderId: 15, created: true });
  assert.equal(createdName, "Projects");
});

test("resolveFolderId guards against nullish, empty, and whitespace-only inputs", async () => {
  const { resolveFolderId } = await load();

  assert.deepEqual(await resolveFolderId(null as unknown as string), {
    error: "Folder name cannot be empty",
  }); // deliberately invalid input
  assert.deepEqual(await resolveFolderId(undefined as unknown as string), {
    error: "Folder name cannot be empty",
  }); // deliberately invalid input
  assert.deepEqual(await resolveFolderId(""), { error: "Folder name cannot be empty" });
  assert.deepEqual(await resolveFolderId("   "), { error: "Folder name cannot be empty" });
});
