import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runElectronFixture } from "../../../lib/runElectronFixture.ts";

for (const outcome of ["success", "compile-error", "timeout"] as const) test(`Electron fixture owns output/profile cleanup on ${outcome}`, { skip: process.platform !== "darwin" }, async (t) => {
  const sources = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-fixture-source-"));
  t.after(() => fs.rmSync(sources, { recursive: true, force: true }));
  const source = path.join(sources, "fixture.ts");
  fs.writeFileSync(source, outcome === "compile-error" ? "invalid syntax @@@" : `
    import { app } from "electron";
    import fs from "node:fs";
    const profile = process.env.GRISTMILL_ELECTRON_FIXTURE_PROFILE;
    if (!profile || !fs.existsSync(profile)) throw new Error("missing parent profile");
    app.setPath("userData", profile);
    app.setPath("sessionData", profile);
    app.whenReady().then(() => {
      console.log("fixture-pid=" + process.pid);
      ${outcome === "timeout" ? "setInterval(() => {}, 1000);" : "app.quit();"}
    });
  `);
  const roots: string[] = [];
  const mkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", (prefix: string) => {
    const root = mkdtemp(prefix);
    if (prefix.includes("gristmill-electron-fixture-")) roots.push(root);
    return root;
  });
  let output = "";
  if (outcome === "success") output = (await runElectronFixture(t, source)).stdout;
  else await assert.rejects(runElectronFixture(t, source, { timeout: 2000 }), error => {
    assert.ok(error instanceof Error);
    output = error.message;
    assert.match(output, outcome === "compile-error" ? /Build failed/ : /Command failed|timed out/);
    return true;
  });
  assert.equal(roots.length, 1);
  assert.equal(fs.existsSync(roots[0]), false, "parent removes both compiled output and synthetic profile before returning");
  if (outcome !== "compile-error") {
    const pid = Number(/fixture-pid=(\d+)/.exec(output)?.[1]);
    assert.ok(pid > 0, "GUI child reached the scenario");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "owned GUI process exited before cleanup");
  }
});
