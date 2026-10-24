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
  // Owner exception (issue #346 item 1): the only per-target full-limit override.
  fullLimitMinutes?: number;
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
  "notes:pending-save": {
    mutate: ["src/lib/noteEditorPendingSave.ts"],
    testFiles: ["test/lib/noteEditorPendingSave.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/notes/pending-save",
  },
  "recording:meet-speaker-evidence": {
    mutate: ["src/helpers/meetSpeakerEvidence.ts"],
    testFiles: ["test/cases/platform/unit/meetSpeakerEvidence.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/meet-speaker-evidence",
  },
  "transcription:routing": {
    mutate: ["src/helpers/transcriptionRoute.ts"],
    testFiles: [
      "test/helpers/transcriptionRoute.test.ts",
      "test/helpers/transcriptionRouteModelAgreement.test.ts",
    ],
    directDependencies: [
      "src/config/constants.mts",
      "src/config/transcriptionCapabilities.ts",
      "src/utils/endpointPolicy.ts",
      "src/utils/azureOpenAI.ts",
      "src/helpers/selfHostedTranscription.ts",
      "src/services/transcriptionBaseUrl.ts",
    ],
    artifactDirectory: "reports/mutation/transcription/routing",
  },
  "transcription:timeout-policy": {
    mutate: ["src/helpers/transcriptionTimeout.ts"],
    testFiles: ["test/helpers/transcriptionTimeout.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/transcription/timeout-policy",
  },
  "transcription:upload-cancellation": {
    mutate: ["src/helpers/uploadCancelRegistry.ts"],
    testFiles: ["test/helpers/uploadCancelRegistry.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/transcription/upload-cancellation",
  },
  "platform:retry-policy": {
    mutate: ["src/utils/retry.ts"],
    testFiles: [
      "test/helpers/apiRetryStrategy.test.ts",
      "test/helpers/fileRetryStrategy.test.ts",
    ],
    directDependencies: ["src/config/constants.mts"],
    artifactDirectory: "reports/mutation/platform/retry-policy",
  },
  "ai:streaming-think-filter": {
    mutate: ["src/services/ai/streamingThinkFilter.ts"],
    testFiles: ["test/services/streamingThinkFilter.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/ai/streaming-think-filter",
  },
  "ai:llm-transcript": {
    mutate: ["src/utils/llmTranscript.ts"],
    testFiles: ["test/utils/llmTranscript.test.ts"],
    directDependencies: [
      "src/contracts/meetingRecording.ts",
      "src/utils/transcriptSpeakerState.ts",
    ],
    artifactDirectory: "reports/mutation/ai/llm-transcript",
  },
  "transcription:export-formatting": {
    mutate: ["src/helpers/transcriptFormatter.ts"],
    testFiles: ["test/helpers/transcriptFormatter.test.ts"],
    directDependencies: ["src/helpers/i18nMain.ts"],
    artifactDirectory: "reports/mutation/transcription/export-formatting",
  },
  "ai:settings-selection": {
    mutate: ["src/config/settingsSelectors.ts"],
    testFiles: ["test/helpers/settingsSelectors.test.ts"],
    directDependencies: [
      "src/config/inferenceScopes.ts",
      "src/config/transcriptionCapabilities.ts",
      "src/helpers/reasoningRouting.ts",
      "src/config/bbAgentPreferences.ts",
    ],
    artifactDirectory: "reports/mutation/ai/settings-selection",
  },
  "notes:list-operations": {
    mutate: ["src/stores/noteListOps.ts"],
    testFiles: ["test/helpers/noteListOps.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/notes/list-operations",
  },
  "calendar:availability": {
    mutate: ["src/helpers/calendarAvailability.ts"],
    testFiles: ["test/helpers/calendarAvailability.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/calendar/availability",
  },
  "platform:endpoint-policy": {
    mutate: ["src/utils/endpointPolicy.ts"],
    testFiles: ["test/helpers/secureEndpoint.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/platform/endpoint-policy",
  },
  "platform:companion-protocol": {
    mutate: ["src/helpers/companionFrames.ts", "src/contracts/companion.ts"],
    testFiles: ["test/cases/platform/unit/companionProtocol.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/platform/companion-protocol",
  },
  "platform:companion-coordinator": {
    mutate: ["src/helpers/companionCoordinator.ts"],
    testFiles: ["test/cases/platform/unit/companionCoordinator.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/platform/companion-coordinator",
  },
  "recording:audio-alignment": {
    mutate: ["src/helpers/meetingAudioAlignment.ts"],
    testFiles: [
      "test/cases/recording/unit/meetingResamplerMapping.test.ts",
      "test/cases/recording/integration/meetingAlignmentPersistence.test.ts",
      "test/cases/recording/unit/meetingAudioAlignment.test.ts",
    ],
    directDependencies: ["src/contracts/meetingRecording.ts"],
    artifactDirectory: "reports/mutation/recording/audio-alignment",
  },
  "recording:capture-write-queue": {
    mutate: ["src/helpers/meetingCaptureWriteQueue.ts"],
    testFiles: ["test/cases/recording/unit/meetingCaptureBackpressure.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/capture-write-queue",
  },
  "notes:transcript-reader": {
    mutate: ["src/helpers/noteTranscriptReader.ts"],
    testFiles: ["test/helpers/noteTranscriptReader.test.ts"],
    directDependencies: ["src/contracts/meetingRecording.ts", "src/contracts/noteRead.ts", "src/helpers/meetingAudioParts.ts", "src/helpers/meetingAudioAlignment.ts"],
    artifactDirectory: "reports/mutation/notes/transcript-reader",
  },
  "recording:retention-settings": {
    mutate: ["src/helpers/retentionSettings.ts"],
    testFiles: ["test/helpers/retentionSettings.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/retention-settings",
  },
  "recording:platform-speaker-matching": {
    mutate: ["src/helpers/meetingPlatformMatcher.ts"],
    testFiles: [
      "test/cases/recording/unit/zoomSpeakerMatcher.test.ts",
      "test/cases/recording/unit/soleRemoteSpeaker.test.ts",
    ],
    directDependencies: ["src/contracts/meetingRecording.ts"],
    artifactDirectory: "reports/mutation/recording/platform-speaker-matching",
    fullLimitMinutes: 45,
  },
  "notes:read-service": {
    mutate: ["src/helpers/noteReadService.ts"],
    testFiles: [
      "test/helpers/noteReadService.test.ts",
      "test/cases/notes/integration/noteOutputReader.test.ts",
      "test/cases/notes/integration/noteReadServiceFixtures.test.ts",
    ],
    directDependencies: ["src/contracts/noteOutput.ts", "src/contracts/meetingRecording.ts", "src/helpers/meetingRunReader.ts", "src/helpers/meetingPromptMaterial.ts", "src/helpers/database.ts"],
    artifactDirectory: "reports/mutation/notes/read-service",
  },
  "recording:processing-retry-policy": {
    mutate: ["src/helpers/meetingProcessingRetry.ts"],
    testFiles: ["test/cases/recording/unit/meetingProcessingRetry.test.ts"],
    directDependencies: [],
    artifactDirectory: "reports/mutation/recording/processing-retry-policy",
  },
} satisfies Record<string, TargetScope>;

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export function targetIds(): string[] {
  return Object.keys(targets);
}

// Resolve one registered target and validate its scope before any Stryker work.
export function resolveTarget(id: string) {
  const scope: TargetScope | undefined = Object.entries(targets).find(
    ([candidate]) => candidate === id
  )?.[1];

  if (!scope)
    throw new Error(
      `Unknown mutation target: ${id}. Supported targets: ${targetIds().join(", ")}`
    );

  for (const file of [...scope.mutate, ...scope.testFiles, ...scope.directDependencies])
    assertSafePath(file, { exists: true });
  assertSafePath(scope.artifactDirectory, { under: "reports/mutation" });

  if (
    scope.fullLimitMinutes !== undefined &&
    (!Number.isInteger(scope.fullLimitMinutes) || scope.fullLimitMinutes <= 0)
  )
    throw new Error(`Invalid mutation full limit for ${id}: ${scope.fullLimitMinutes}`);

  return {
    name: id,
    ...scope,
    timeoutMs: {
      "dry-run": dryRunTimeoutMs,
      full: scope.fullLimitMinutes ? scope.fullLimitMinutes * 60_000 : fullTimeoutMs,
    },
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
