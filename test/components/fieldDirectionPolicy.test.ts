const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer }: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

const repoRoot = path.join(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function componentFiles(directory: string) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry: import("node:fs").Dirent) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(absolutePath);
    return /\.(?:tsx|jsx)$/.test(entry.name) ? [absolutePath] : [];
  });
}

function sharedFieldInventory() {
  return componentFiles(path.join(repoRoot, "src/components")).flatMap((absolutePath: string) => {
    const text = fs.readFileSync(absolutePath, "utf8");
    return [...text.matchAll(/<(Input|Textarea)\b[\s\S]*?\/>/g)].map((match) => ({
      file: path.relative(repoRoot, absolutePath).split(path.sep).join("/"),
      direction: match[0].match(/\bdir="([^"]+)"/)?.[1] ?? "inherit",
    }));
  });
}

function nativeFieldInventory() {
  const primitiveFiles = new Set(["src/components/ui/input.tsx", "src/components/ui/textarea.tsx"]);

  return componentFiles(path.join(repoRoot, "src/components")).flatMap((absolutePath: string) => {
    const file = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
    if (primitiveFiles.has(file)) return [];

    const text = fs.readFileSync(absolutePath, "utf8");
    return [...text.matchAll(/<(input|textarea)\b[\s\S]*?\/>/g)].map((match) => ({
      file,
      direction: match[0].match(/\bdir="([^"]+)"/)?.[1] ?? "inherit",
    }));
  });
}

interface DirectionField { file: string; direction: string; }
function inventoryByFile(inventory: DirectionField[]) {
  return inventory.reduce((result: Record<string, string[]>, field: DirectionField) => {
    (result[field.file] ??= []).push(field.direction);
    return result;
  }, {});
}

// This is the review record, not just a total. Source order distinguishes
// multiple fields in the same component and makes any new or reclassified
// consumer require an explicit policy decision in this test.
const EXPECTED_SHARED_FIELD_DIRECTIONS = {
  "src/components/ControlPanel.tsx": ["auto"],
  "src/components/DictionaryView.tsx": ["auto", "auto", "auto"],
  "src/components/OpenAICompatiblePanel.tsx": ["ltr"],
  "src/components/SnippetsView.tsx": ["auto", "auto", "auto", "auto"],
  "src/components/notes/ActionManagerDialog.tsx": ["auto", "auto"],
  "src/components/notes/UploadAudioView.tsx": ["auto"],
  "src/components/onboarding/ProviderSetupStep.tsx": ["ltr", "ltr", "ltr", "ltr"],
  "src/components/settings/ProfileNameField.tsx": ["auto"],
  "src/components/settings/models/ProviderCredentialsForm.tsx": ["ltr"],
  "src/components/settings/models/TaskModelPicker.tsx": ["ltr", "ltr"],
  "src/components/ui/ApiKeyInput.tsx": ["ltr"],
  "src/components/ui/SearchableModelList.tsx": ["ltr"],
};

const EXPECTED_NATIVE_FIELD_DIRECTIONS = {
  "src/components/CommandSearch.tsx": ["auto"],
  "src/components/SettingsPage.tsx": ["ltr"],
  "src/components/bb/BbModelPanel.tsx": ["auto"],
  "src/components/chat/ChatInput.tsx": ["auto"],
  "src/components/notes/ActionManagerDialog.tsx": ["auto"],
  "src/components/notes/AddNotesToFolderDialog.tsx": ["auto"],
  "src/components/notes/MeetingTranscriptChat.tsx": ["ltr", "auto"],
  "src/components/notes/MeetingResultsPanel.tsx": ["auto"],
  "src/components/notes/NoteBottomBar.tsx": ["auto"],
  "src/components/notes/NoteEditor.tsx": ["auto", "auto"],
  "src/components/notes/NoteFindBar.tsx": ["auto"],
  "src/components/notes/NoteParticipants.tsx": ["auto"],
  "src/components/notes/SpacesTree.tsx": ["auto", "auto", "auto", "auto"],
  "src/components/notes/UploadAudioView.tsx": ["ltr", "ltr", "inherit", "inherit"],
  "src/components/onboarding/LanguageSelectionStep.tsx": ["auto"],
  "src/components/settings/models/ModelsSettings.tsx": ["auto"],
  "src/components/settings/models/TaskModelPicker.tsx": ["auto"],
};

test("shared field primitives inherit unless a consumer declares its content direction", async (t: import("node:test").TestContext) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-field-direction-primitives-",
  });
  const { Input } = await vite.ssrLoadModule("/components/ui/input.tsx");
  const { Textarea } = await vite.ssrLoadModule("/components/ui/textarea.tsx");

  const inherited = renderToStaticMarkup(
    React.createElement(Input, { value: "مرحبا OpenWhispr 2.0", readOnly: true })
  );
  assert.doesNotMatch(inherited, /\sdir=/);
  assert.match(inherited, /value="مرحبا OpenWhispr 2.0"/);

  const technicalPassword = renderToStaticMarkup(
    React.createElement(Input, {
      dir: "ltr",
      type: "password",
      value: "سر-sk_ABC/123",
      readOnly: true,
    })
  );
  assert.match(technicalPassword, /\sdir="ltr"/);
  assert.match(technicalPassword, /value="سر-sk_ABC\/123"/);

  const prose = renderToStaticMarkup(
    React.createElement(Textarea, {
      dir: "auto",
      value: "مرحبا OpenWhispr 2.0",
      readOnly: true,
    })
  );
  assert.match(prose, /\sdir="auto"/);
  assert.match(prose, />مرحبا OpenWhispr 2.0<\/textarea>/);
});

test("every shared Input and Textarea consumer has an explicit reviewed classification", () => {
  const inventory = sharedFieldInventory();
  assert.deepEqual(inventoryByFile(inventory), EXPECTED_SHARED_FIELD_DIRECTIONS);
});

test("native text fields use the same reviewed direction policy", () => {
  const inventory = nativeFieldInventory();
  assert.deepEqual(inventoryByFile(inventory), EXPECTED_NATIVE_FIELD_DIRECTIONS);
});

test("representative prose, identity, secret, and rich-editor surfaces keep their policy", () => {

  assert.match(
    source("src/components/onboarding/ProviderSetupStep.tsx"),
    /<Input\s+dir="ltr"\s+type="password"/
  );
  assert.match(
    source("src/components/DictionaryView.tsx"),
    /<Input\s+dir="auto"\s+ref=\{addInputRef\}/
  );
  assert.match(
    source("src/components/notes/UploadAudioView.tsx"),
    /<input\s+dir="ltr"\s+type="url"/
  );

  assert.match(
    source("src/components/ui/ApiKeyInput.tsx"),
    /<span\s+dir="ltr"[\s\S]*?\{maskKey\(apiKey\)\}/
  );
  assert.match(
    source("src/components/ui/ApiKeyInput.tsx"),
    /<Input\s+dir="ltr"[\s\S]*?value=\{draft\}/
  );
  assert.match(source("src/components/ui/HotkeyInput.tsx"), /<div\s+dir="ltr"/);
  assert.match(source("src/components/ErrorBoundary.tsx"), /<pre\s+dir="ltr"/);
  assert.match(
    source("src/components/notes/NoteEditor.tsx"),
    /<div\s+dir="auto"\s+ref=\{titleRef\}/
  );
  assert.match(source("src/components/ui/RichTextEditor.tsx"), /dir: "auto"/);
  assert.match(
    source("src/index.css"),
    /\.rich-text-editor-content \{[\s\S]*?unicode-bidi: plaintext;/
  );
  assert.match(
    source("src/index.css"),
    /\.rich-text-editor-content code,[\s\S]*?direction: ltr;[\s\S]*?unicode-bidi: isolate;/
  );
});
