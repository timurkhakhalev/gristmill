import test from "node:test";
import assert from "node:assert/strict";


test("mutation arguments reject malformed selections and unknown targets before execution", async () => {
  const { parseArguments } = await import("../../../../scripts/mutation.mts");
  assert.equal(parseArguments(["--list"]), null);
  assert.deepEqual(parseArguments(["--target", "recording:resampler-mapping", "--mode", "dry-run"]), {
    target: "recording:resampler-mapping", mode: "dry-run",
  });
  for (const args of [[], ["--target", "recording:resampler-mapping"], ["--target", "recording:resampler-mapping", "--mode", "all"], ["--list", "--mode", "full"]]) {
    assert.throws(() => parseArguments(args), /Usage/);
  }
  assert.throws(() => parseArguments(["--target", "../../secrets", "--mode", "full"]), /Unknown mutation target/);
});

test("each registered target resolves independently with its own scope and the shared timeout policy", async () => {
  const { targets, resolveTarget } = await import("../../../../scripts/mutation-targets.mts");
  const artifactDirectories = new Set<string>();
  for (const [id, scope] of Object.entries(targets)) {
    const resolved = resolveTarget(id);
    assert.equal(resolved.name, id);
    assert.deepEqual(resolved.mutate, scope.mutate);
    assert.deepEqual(resolved.testFiles, scope.testFiles);
    for (const key of Object.keys(scope))
      assert.equal(
        ["mutate", "testFiles", "directDependencies", "artifactDirectory", "fullLimitMinutes"].includes(key),
        true,
        `unknown scope field on ${id}: ${key}`
      );
    assert.deepEqual(resolved.timeoutMs, {
      "dry-run": 300_000,
      full: id === "recording:platform-speaker-matching" ? 2_700_000 : 1_200_000,
    });
    assert.equal(resolved.artifactDirectory.startsWith("reports/mutation/"), true);
    assert.equal(artifactDirectories.has(resolved.artifactDirectory), false);
    artifactDirectories.add(resolved.artifactDirectory);
  }
  assert.deepEqual(targets["recording:resampler-mapping"]?.mutate, ["src/helpers/meetingResamplerMapping.ts"]);
  assert.deepEqual(targets["recording:clock-sync"]?.testFiles, ["test/cases/recording/unit/meetingClockSync.test.ts"]);
  assert.deepEqual(targets["recording:audio-timeline"]?.mutate, ["src/helpers/meetingAudioTimeline.ts"]);
  assert.deepEqual(targets["recording:system-audio-watchdog"]?.testFiles, ["test/helpers/meetingSystemAudioWatchdog.test.ts"]);
  assert.deepEqual(targets["recording:session-lifecycle"]?.mutate, ["src/helpers/meetingRecordingSession.ts"]);
  assert.deepEqual(targets["recording:main-session-lifecycle"]?.mutate, ["src/helpers/meetingTranscriptionLifecycle.ts"]);
  assert.deepEqual(targets["recording:speaker-assignment"]?.mutate, ["src/helpers/speakerAssignmentPolicy.ts"]);
  assert.deepEqual(targets["notes:pending-save"]?.mutate, ["src/lib/noteEditorPendingSave.ts"]);
  assert.deepEqual(targets["recording:meet-speaker-evidence"]?.mutate, ["src/helpers/meetSpeakerEvidence.ts"]);
  assert.deepEqual(targets["transcription:routing"]?.testFiles, ["test/helpers/transcriptionRoute.test.ts", "test/helpers/transcriptionRouteModelAgreement.test.ts"]);
  assert.deepEqual(targets["transcription:timeout-policy"]?.mutate, ["src/helpers/transcriptionTimeout.ts"]);
  assert.deepEqual(targets["transcription:upload-cancellation"]?.mutate, ["src/helpers/uploadCancelRegistry.ts"]);
  assert.deepEqual(targets["platform:retry-policy"]?.testFiles, ["test/helpers/apiRetryStrategy.test.ts", "test/helpers/fileRetryStrategy.test.ts"]);
  assert.deepEqual(targets["recording:processing-retry-policy"]?.mutate, ["src/helpers/meetingProcessingRetry.ts"]);
  assert.deepEqual(targets["ai:streaming-think-filter"]?.mutate, ["src/services/ai/streamingThinkFilter.ts"]);
  assert.deepEqual(targets["ai:llm-transcript"]?.mutate, ["src/utils/llmTranscript.ts"]);
  assert.deepEqual(targets["transcription:export-formatting"]?.mutate, ["src/helpers/transcriptFormatter.ts"]);
  assert.deepEqual(targets["ai:settings-selection"]?.mutate, ["src/config/settingsSelectors.ts"]);
  assert.deepEqual(targets["notes:list-operations"]?.mutate, ["src/stores/noteListOps.ts"]);
  assert.deepEqual(targets["calendar:availability"]?.mutate, ["src/helpers/calendarAvailability.ts"]);
  assert.deepEqual(targets["platform:endpoint-policy"]?.mutate, ["src/utils/endpointPolicy.ts"]);
  assert.deepEqual(targets["platform:companion-protocol"]?.mutate, ["src/helpers/companionFrames.ts", "src/contracts/companion.ts"]);
  assert.deepEqual(targets["platform:companion-coordinator"]?.mutate, ["src/helpers/companionCoordinator.ts"]);
  assert.deepEqual(targets["recording:audio-alignment"]?.mutate, ["src/helpers/meetingAudioAlignment.ts"]);
  assert.deepEqual(targets["recording:audio-alignment"]?.testFiles, ["test/cases/recording/unit/meetingResamplerMapping.test.ts", "test/cases/recording/integration/meetingAlignmentPersistence.test.ts", "test/cases/recording/unit/meetingAudioAlignment.test.ts"]);
  assert.deepEqual(targets["recording:capture-write-queue"]?.mutate, ["src/helpers/meetingCaptureWriteQueue.ts"]);
  assert.deepEqual(targets["recording:capture-write-queue"]?.testFiles, ["test/cases/recording/unit/meetingCaptureBackpressure.test.ts"]);
  assert.deepEqual(targets["notes:transcript-reader"]?.mutate, ["src/helpers/noteTranscriptReader.ts"]);
  assert.deepEqual(targets["notes:transcript-reader"]?.testFiles, ["test/helpers/noteTranscriptReader.test.ts"]);
  assert.deepEqual(targets["recording:retention-settings"]?.mutate, ["src/helpers/retentionSettings.ts"]);
  assert.deepEqual(targets["recording:retention-settings"]?.testFiles, ["test/helpers/retentionSettings.test.ts"]);
  assert.deepEqual(targets["recording:platform-speaker-matching"]?.mutate, ["src/helpers/meetingPlatformMatcher.ts"]);
  assert.deepEqual(targets["recording:platform-speaker-matching"]?.testFiles, ["test/cases/recording/unit/zoomSpeakerMatcher.test.ts", "test/cases/recording/unit/soleRemoteSpeaker.test.ts"]);
  assert.equal(targets["recording:platform-speaker-matching"]?.fullLimitMinutes, 45);
  assert.deepEqual(targets["notes:read-service"]?.mutate, ["src/helpers/noteReadService.ts"]);
  assert.deepEqual(targets["notes:read-service"]?.testFiles, ["test/helpers/noteReadService.test.ts", "test/cases/notes/integration/noteOutputReader.test.ts", "test/cases/notes/integration/noteReadServiceFixtures.test.ts"]);
  assert.throws(() => resolveTarget("recording:no-such-target"), /Unknown mutation target/);
  assert.throws(() => resolveTarget("../../secrets"), /Unknown mutation target/);
});

test("scope validation rejects unsafe and missing paths", async () => {
  const { assertSafePath } = await import("../../../../scripts/mutation-targets.mts");
  for (const candidate of ["/tmp/evil.ts", "../evil.ts", "src/../../evil.ts", "reports/mutation/../../evil", "src//evil.ts", "./src/evil.ts", "reports/mutation"]) {
    assert.throws(
      () => assertSafePath(candidate, { exists: true, under: "reports/mutation" }),
      /Unsafe mutation path|must stay under|Missing mutation path/,
    );
  }
  assertSafePath("scripts/mutation-targets.mts", { exists: true });
  assertSafePath("reports/mutation/recording/resampler-mapping", { under: "reports/mutation" });
  assert.throws(() => assertSafePath("scripts/this-synthetic-file-does-not-exist.mts", { exists: true }), /Missing mutation path/);
});

test("fingerprints change when any scoped input path or content changes", async () => {
  const { fingerprintDigest } = await import("../../../../scripts/mutation.mts");
  const input = [{ path: "src/synthetic.ts", content: "export const answer = 42;" }];
  const baseline = fingerprintDigest(input);
  assert.equal(fingerprintDigest([...input]), baseline);
  assert.notEqual(fingerprintDigest([{ path: "src/synthetic.ts", content: "export const answer = 43;" }]), baseline);
  assert.notEqual(fingerprintDigest([{ path: "src/renamed.ts", content: "export const answer = 42;" }]), baseline);
  assert.notEqual(fingerprintDigest([...input, { path: "test/synthetic.test.ts", content: 'import { answer } from "../src/synthetic.js";' }]), baseline);
});

test("fingerprint inputs bind the selected scope, direct dependencies and shared runner files", async () => {
  const { fingerprintFiles } = await import("../../../../scripts/mutation.mts");
  const { resolveTarget } = await import("../../../../scripts/mutation-targets.mts");
  const files = fingerprintFiles(resolveTarget("recording:resampler-mapping"));
  for (const required of [
    "stryker.config.mts",
    "scripts/mutation-targets.mts",
    "scripts/mutation-cloud/entrypoint.sh",
    "src/helpers/meetingResamplerMapping.ts",
    "src/helpers/meetingAudioAlignment.ts",
    "test/cases/recording/unit/meetingResamplerMapping.test.ts",
  ])
    assert.equal(files.includes(required), true, `missing fingerprint input: ${required}`);
  assert.equal(new Set(files).size, files.length);
});

test("stryker receives exactly the selected source and tests", async () => {
  process.env.MUTATION_TARGET = "recording:resampler-mapping";
  try {
    const { default: config } = await import("../../../../stryker.config.mts");
    assert.deepEqual(config.mutate, ["src/helpers/meetingResamplerMapping.ts"]);
    assert.equal(config.commandRunner.command, "pnpm test -- test/cases/recording/unit/meetingResamplerMapping.test.ts");
    assert.equal(config.concurrency, 1);
    assert.deepEqual(config.thresholds, { high: 80, low: 60, break: null });
  } finally {
    delete process.env.MUTATION_TARGET;
  }
});

test("mutation outcomes keep survivors, timeouts and errors distinct from kills", async () => {
  const { outcomeCounts } = await import("../../../../scripts/mutation.mts");
  const statuses = ["Killed", "Killed", "Survived", "NoCoverage", "Timeout", "RuntimeError", "CompileError", "Ignored", "Pending"];
  assert.deepEqual(outcomeCounts(JSON.stringify({ files: { "synthetic.ts": { mutants: statuses.map(status => ({ status })) } } })), {
    killed: 2, survived: 1, noCoverage: 1, timeout: 1, runtimeError: 1, compileError: 1, ignored: 1, pending: 1,
  });
  assert.throws(() => outcomeCounts(JSON.stringify({ files: { "synthetic.ts": { mutants: [{ status: "Invalid" }] } } })));
});
