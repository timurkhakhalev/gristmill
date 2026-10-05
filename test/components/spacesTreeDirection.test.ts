const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const load = () => import("../../src/components/notes/treeDirection.ts");

test("tree horizontal keys use logical inward and outward movement in LTR", async () => {
  const { treeHorizontalIntent } = await load();
  assert.equal(treeHorizontalIntent("ArrowRight", "ltr"), "inward");
  assert.equal(treeHorizontalIntent("ArrowLeft", "ltr"), "outward");
  assert.equal(treeHorizontalIntent("ArrowDown", "ltr"), null);
});

test("tree horizontal keys mirror logical inward and outward movement in RTL", async () => {
  const { treeHorizontalIntent } = await load();
  assert.equal(treeHorizontalIntent("ArrowLeft", "rtl"), "inward");
  assert.equal(treeHorizontalIntent("ArrowRight", "rtl"), "outward");
  assert.equal(treeHorizontalIntent("ArrowUp", "rtl"), null);
});

test("SpacesTree resolves horizontal keyboard intent from the active i18n direction", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/components/notes/SpacesTree.tsx"),
    "utf8"
  );

  assert.match(source, /treeHorizontalIntent\(event\.key, i18n\.dir\(\)\)/);
});
