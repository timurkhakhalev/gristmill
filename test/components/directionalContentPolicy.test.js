const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("dynamic prose and identity values keep their own direction", () => {
  const expectations = [
    ["src/components/DictionaryView.tsx", /<span\s+dir="auto"[^>]*>\s*\{word\}/],
    ["src/components/SnippetsView.tsx", /<span\s+dir="auto"[^>]*>\s*\{snippet\.trigger\}/],
    ["src/components/SnippetsView.tsx", /<span\s+dir="auto"[^>]*>\s*\{snippet\.replacement\}/],

    [
      "src/components/notes/UploadAudioView.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{downloadProgress\.title\}/,
    ],
    ["src/components/notes/UploadAudioView.tsx", /<span\s+dir="auto"[^>]*>\s*\{f\.name\}/],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost its content-direction policy`);
  }
});

test("technical output values remain LTR inside an Arabic document", () => {
  const expectations = [
    ["src/components/DeveloperSection.tsx", /<code\s+dir="ltr"[\s\S]*?\{logPath\}/],
    [
      "src/components/TestConnectionButton.tsx",
      /<code\s+dir="ltr"[^>]*>\s*\{errorInfo\.copyCommand\}/,
    ],
    ["src/components/ui/TechnicalErrorDetails.tsx", /<pre\s+dir="ltr"[\s\S]*?\{text\}/],

    [
      "src/components/EnterpriseProviderConfig.tsx",
      /<select\s+dir="ltr"\s+value=\{store\.bedrockRegion\}/,
    ],
    [
      "src/components/EnterpriseProviderConfig.tsx",
      /<select\s+dir="ltr"\s+value=\{store\.vertexLocation\}/,
    ],
    [
      "src/components/notes/UploadAudioView.tsx",
      /<p\s+dir="ltr"[^>]*font-medium[^>]*>\s*\{file\.name\}/,
    ],
    [
      "src/components/notes/UploadAudioView.tsx",
      /<p\s+dir="ltr"[^>]*max-w-50[^>]*>\s*\{file\.name\}/,
    ],
    ["src/components/ui/SidebarModal.tsx", /<span\s+dir="ltr"[\s\S]*?v\{version\}/],
    ["src/components/ui/ModelCardList.tsx", /<span\s+dir="ltr"[\s\S]*?\{model\.label\}/],
    [
      "src/components/onboarding/ProviderSetupStep.tsx",
      /<span\s+dir="ltr">\s*\{models\.find[\s\S]*?\?\? t\("onboarding\.rehaul\.provider\.modelPlaceholder"\)\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost its LTR technical-output isolation`);
  }
});

test("localized sentences isolate technical interpolations without changing word order", () => {
  const expectations = [
    [
      "src/components/IntegrationsView.tsx",
      /<BidiInterpolatedText[\s\S]*?googleCalendar\.disconnectConfirm[\s\S]*?value=\{confirmDisconnectEmail\}/,
    ],
    [
      "src/components/IntegrationsView.tsx",
      /<BidiInterpolatedText[\s\S]*?microsoftCalendar\.disconnectConfirm[\s\S]*?value=\{confirmMsDisconnectEmail\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    const text = source(file);
    assert.match(text, pattern, `${file} lost a bidi-isolated technical interpolation`);
    assert.match(text, /BIDI_VALUE_TOKEN/, `${file} must interpolate with the stable marker`);
  }
});

test("user-authored names and previews detect direction at their display boundary", () => {
  const expectations = [
    ["src/components/CommandSearch.tsx", /<span\s+dir="auto"[^>]*>\s*\{spaceLabel\(scopeSpace\)\}/],
    ["src/components/CommandSearch.tsx", /<span\s+dir="auto"[^>]*>\s*\{spaceLabel\(space\)\}/],
    ["src/components/CommandSearch.tsx", /<p\s+dir="auto"[^>]*>\s*\{target\.label\}/],
    ["src/components/chat/ChatMessage.tsx", /<p\s+dir="auto"[^>]*>\s*\{title\}/],
    ["src/components/DictionaryView.tsx", /<span\s+dir="auto"[^>]*>\s*\{agentName\}/],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{speakerLabel\}/,
    ],
    ["src/components/notes/MeetingTranscriptChat.tsx", /<span\s+dir="auto"[^>]*>\s*\{text\}/],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{segment\.suggestedName\}/,
    ],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{displayLabel\}/,
    ],

    ["src/components/notes/NoteEditor.tsx", /<span\s+dir="auto"[^>]*>\s*\{folderName\}/],
    [
      "src/components/notes/NoteEditor.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{defaultFolderDisplayName\(folder, t\)\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost a dynamic-content direction boundary`);
  }

  const meetingCards = source("src/components/UpcomingMeetings.tsx").match(
    /<p\s+dir="auto"[^>]*>\s*\{event\.summary \|\| t\("upcoming\.untitledEvent"\)\}/g
  );
  assert.equal(
    meetingCards?.length,
    2,
    "both calendar event summary displays must detect direction"
  );
});
