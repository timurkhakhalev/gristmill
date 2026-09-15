const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

test("M4 removes the standalone dictation and voice-assistant surface", () => {
  const removed = [
    "src/helpers/audioManager.js",
    "src/hooks/useAudioRecording.js",
    "src/hooks/useAssistantPanel.js",
    "src/hooks/useOnboardingAssistantDemo.ts",
    "src/hooks/useLiveTranscriptPanel.js",
    "src/helpers/selectionManager.js",
    "src/helpers/selectionEditing.js",
    "src/helpers/screenContextCapture.js",
    "src/helpers/dictationLifecycle.js",
    "src/helpers/dictationStreamingRouting.js",
    "src/helpers/dictationTranslationInference.js",
    "src/helpers/assistantResponseDelivery.ts",
    "src/helpers/assistantSessionState.js",
    "src/helpers/voicePillPresentation.js",
    "src/helpers/voiceSurfaceGeometry.js",
    "src/helpers/voiceSurfaceGeometry.mjs",
    "src/helpers/voiceSurfaceGeometry.json",
    "src/helpers/localSpeechGate.js",
    "src/helpers/micTrackHealth.js",
    "src/helpers/micWarmState.js",
    "src/helpers/preparedMicCapture.js",
    "src/helpers/micStreamHold.js",
    "src/helpers/staleMicDevice.js",
    "src/helpers/discardedRecording.js",
    "src/helpers/recordingValidation.js",
    "src/helpers/recordingGuard.js",
    "src/helpers/transcriptionFallback.js",
    "src/helpers/transcriptionAuth.js",
    "src/config/agentDetection.ts",
    "src/utils/dictationCues.js",
    "src/utils/dictationReadiness.ts",
    "src/utils/onboardingDemo.ts",
    "src/utils/transcriptionPreview.ts",
    "src/utils/assistantSelection.ts",
    "src/components/dictation",
    "src/components/notes/DictationWidget.tsx",
    "src/components/onboarding/DemoStep.tsx",
    "src/components/onboarding/AssistantHotkeyPreview.tsx",
    "src/components/onboarding/assistantDemoScenario.ts",
    "src/components/settings/DictationAgentSettings.tsx",
    "src/components/settings/DictationTranslationSettings.tsx",
    "src/components/ui/PasteToolsInfo.tsx",
    "src/components/ui/NixOsPasteInfo.tsx",
    "src/utils/linuxPasteTools.ts",
    "src/helpers/textEditMonitor.js",
    "src/utils/correctionLearner.js",
  ];

  for (const relativePath of removed) {
    assert.equal(exists(relativePath), false, `${relativePath} must be removed by M4`);
  }
});

test("M4 keeps the meeting recorder and Dictionary/Snippets foundations", () => {
  for (const relativePath of [
    "src/stores/meetingRecordingStore.ts",
    "src/helpers/audioTapManager.ts",
    "src/helpers/meetingSystemAudioWatchdog.ts",
    "src/utils/snippets.ts",
  ]) {
    assert.equal(exists(relativePath), true, `${relativePath} is a preserved consumer`);
  }
});
