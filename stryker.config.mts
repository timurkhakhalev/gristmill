import { resolveTarget } from "./scripts/mutation-targets.mts";

// The runner exports MUTATION_TARGET after validating the CLI selection. A
// direct Stryker invocation must name a registered target; there is no
// whole-repository mutation default.
const targetId = process.env.MUTATION_TARGET;

if (!targetId)
  throw new Error(
    "MUTATION_TARGET is not set. Run: pnpm mutation --list, then pnpm mutation --target <id> --mode dry-run|full"
  );

const target = resolveTarget(targetId);

export default {
  packageManager: "pnpm",
  testRunner: "command",
  commandRunner: { command: `pnpm test -- ${target.testFiles.join(" ")}` },
  coverageAnalysis: "off",
  // tsx transpiles the focused tests without type checking.
  disableTypeChecks: false,
  mutate: target.mutate,
  concurrency: 1,
  dryRunTimeoutMinutes: 4,
  timeoutMS: 10_000,
  thresholds: { high: 80, low: 60, break: null },
  reporters: ["progress", "clear-text", "html", "json"],
  htmlReporter: { fileName: `${target.artifactDirectory}/mutation-report.html` },
  jsonReporter: { fileName: `${target.artifactDirectory}/mutation-report.json` },
  ignorePatterns: ["reports/**", ".tasks/**", "resources/**", "docs/screenshots/**"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};
