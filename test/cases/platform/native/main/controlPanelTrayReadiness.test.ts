import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runElectronFixture } from "../../../../lib/runElectronFixture.ts";

test(
  "tray actions survive delayed ControlPanel mount and reload",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const result = await runElectronFixture(
      t,
      path.join(__dirname, "../../../../helpers/controlPanelTrayReadinessElectron.ts"),
      { timeout: 30_000 }
    );

    assert.match(result.stdout, /tray readiness actions passed/);
  }
);
