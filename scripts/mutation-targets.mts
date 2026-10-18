import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Explicit allowlist of mutation targets. Each entry binds one target ID to its
// production scope, focused tests, direct dependencies and artifact directory.
// Worker count and timeouts stay global runner policy.
const dryRunTimeoutMs = 300_000;

const fullTimeoutMs = 1_200_000;

type TargetScope = {
  mutate: string[];
  testFiles: string[];
  directDependencies: string[];
  artifactDirectory: string;
};

export const targets = {
  "recording:resampler-mapping": {
    mutate: ["src/helpers/meetingResamplerMapping.ts"],
    testFiles: ["test/cases/recording/unit/meetingResamplerMapping.test.ts"],
    directDependencies: [
      "src/helpers/meetingAudioAlignment.ts",
      "test/helpers/harness/meetingResampler.ts",
    ],
    artifactDirectory: "reports/mutation/recording/resampler-mapping",
  },
  "recording:clock-sync": {
    mutate: ["src/helpers/meetingClockSync.ts"],
    testFiles: ["test/cases/recording/unit/meetingClockSync.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/clock-sync",
  },
  "recording:audio-timeline": {
    mutate: ["src/helpers/meetingAudioTimeline.ts"],
    testFiles: ["test/helpers/meetingAudioTimeline.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/audio-timeline",
  },
  "recording:system-audio-watchdog": {
    mutate: ["src/helpers/meetingSystemAudioWatchdog.ts"],
    testFiles: ["test/helpers/meetingSystemAudioWatchdog.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/system-audio-watchdog",
  },
  "recording:session-lifecycle": {
    mutate: ["src/helpers/meetingRecordingSession.ts"],
    testFiles: ["test/helpers/meetingRecordingSession.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/session-lifecycle",
  },
  "recording:main-session-lifecycle": {
    mutate: ["src/helpers/meetingTranscriptionLifecycle.ts"],
    testFiles: ["test/helpers/meetingTranscriptionLifecycle.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/main-session-lifecycle",
  },
  "recording:speaker-assignment": {
    mutate: ["src/helpers/speakerAssignmentPolicy.ts"],
    testFiles: ["test/helpers/speakerAssignmentPolicy.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/speaker-assignment",
  },
  "recording:platform-speaker-matching": {
    mutate: ["src/helpers/meetingPlatformMatcher.ts"],
    testFiles: [
      "test/cases/recording/unit/zoomSpeakerMatcher.test.ts",
      "test/cases/recording/unit/soleRemoteSpeaker.test.ts",
    ],
    directDependencies: ["src/contracts/meetingRecording.ts"],
    artifactDirectory: "reports/mutation/recording/platform-speaker-matching",
  },
} satisfies Record<string, TargetScope>;

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export function targetIds(): string[] {
  return Object.keys(targets);
}

// Resolve one registered target and validate its scope before any Stryker work.
export function resolveTarget(id: string) {
  const scope = Object.entries(targets).find(([candidate]) => candidate === id)?.[1];

  if (!scope)
    throw new Error(
      `Unknown mutation target: ${id}. Supported targets: ${targetIds().join(", ")}`
    );

  for (const file of [...scope.mutate, ...scope.testFiles, ...scope.directDependencies])
    assertSafePath(file, { exists: true });
  assertSafePath(scope.artifactDirectory, { under: "reports/mutation" });

  return {
    name: id,
    ...scope,
    timeoutMs: { "dry-run": dryRunTimeoutMs, full: fullTimeoutMs },
  };
}

// Reject absolute, escaping and non-normalized paths before any Stryker work.
export function assertSafePath(
  candidate: string,
  options: { exists?: boolean; under?: string }
): void {
  if (path.isAbsolute(candidate) || path.normalize(candidate) !== candidate)
    throw new Error(`Unsafe mutation path: ${candidate}`);

  const relative = path.relative(repoRoot, path.resolve(repoRoot, candidate));

  if (relative === "" || relative.startsWith(".."))
    throw new Error(`Unsafe mutation path: ${candidate}`);

  if (options.under) {
    const bounded = path.relative(path.resolve(repoRoot, options.under), path.resolve(repoRoot, candidate));

    if (bounded === "" || bounded.startsWith(".."))
      throw new Error(`Mutation path ${candidate} must stay under ${options.under}`);
  }

  if (options.exists && !existsSync(path.resolve(repoRoot, candidate)))
    throw new Error(`Missing mutation path: ${candidate}`);
}
