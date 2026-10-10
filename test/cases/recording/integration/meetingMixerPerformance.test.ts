import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productionBenchmark } from "../../../helpers/harness/meetingMixerBenchmark.ts";
import { verifyWaveformControls } from "../../../benchmarks/meeting-waveform-check.mts";

test(
  "production mixer smoke covers all layouts and calibration/generation/gap/overlap windows",
  { timeout: 30000 },
  async (t) => {
    verifyWaveformControls();
    const report = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-smoke-"));
    t.after(() => fs.rmSync(report, { recursive: true, force: true }));
    await productionBenchmark(t, 24, report, undefined, true);
  }
);
