import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
if (!process.versions.electron) {
  const electron: string = require("electron");
  const result = spawnSync(
    electron,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", REQUIRE_DB_TESTS: "1", NODE_ENV: "test" },
    }
  );
  // Never rebuild SQLite here: the canonical runtime must already be prepared.
  process.exit(result.status ?? 1);
}
const { default: test } = await import("node:test");
const { productionBenchmark } = await import("../helpers/harness/meetingMixerBenchmark.ts");
const { verifyWaveformControls } = await import("./meeting-waveform-check.mts");
const oracleControls = verifyWaveformControls();
const args = process.argv.slice(2),
  copied = args[0] === "--copied-fixture";
assert.ok(!copied || args.length === 2);
const durations = copied ? [null] : args.map(Number);
assert.ok(
  durations.length > 0 &&
    (copied ||
      durations.every((value) => value !== null && Number.isSafeInteger(value) && value >= 12))
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-mixer-evidence-"));
fs.chmodSync(root, 0o700);
if (!copied)
  console.log(
    "SYNTHETIC_ENVIRONMENT",
    JSON.stringify({
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      memoryBytes: os.totalmem(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.version,
      revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      nativeBuild: JSON.parse(
        fs.readFileSync("resources/licenses/meeting-resampler/build.json", "utf8")
      ),
      nativeDependencies: execFileSync("otool", ["-L", "resources/bin/meeting-resampler"], {
        encoding: "utf8",
      }),
      decoderVersion: execFileSync(require("ffmpeg-static"), ["-version"], {
        encoding: "utf8",
      }).split("\n")[0],
      oracle: oracleControls,
    })
  );
for (const [index, seconds] of durations.entries())
  test(
    copied ? "private copied fixture production replay" : `synthetic production ${seconds}s`,
    { timeout: 1800000 },
    async (t) => {
      const results = await productionBenchmark(
        t,
        seconds,
        path.join(root, String(index)),
        copied ? args[1] : undefined
      );
      if (copied) console.log("Private replay completed. Detailed evidence and excerpts:", root);
      else {
        console.log("SYNTHETIC_RESULT", JSON.stringify({ seconds, results, evidence: root }));
        for (const result of results)
          if (seconds === 3600 || seconds === 7200)
            assert.ok(
              result.wallSeconds <= (seconds === 3600 ? 30 : 60),
              "required wall-time limit exceeded"
            );
      }
    }
  );
