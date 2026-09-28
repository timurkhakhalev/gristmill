const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");

const root = path.join(__dirname, "..");
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

test("M7b settings and notes surfaces stay local-only", () => {
  const files = [
    "src/components/SettingsPage.tsx",
    "src/components/SettingsModal.tsx",
    "src/components/notes/SpacesTree.tsx",
    "src/components/notes/PersonalNotesView.tsx",
    "src/components/home/HomeView.tsx",
    "src/components/home/RecentNotes.tsx",
    "src/hooks/useNotesOnboarding.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /useAuth|usePolicy|workspaceStore|InviteTeammateDialog|SyncService|cloudApi|useUsage|managedByOrg/,
      `${file} must not retain account, policy, workspace, or cloud sync wiring`);
  }
});

test("dictionary and snippets have no cloud service leaves", () => {
  assert.equal(fs.existsSync(path.join(root, "src/services/DictionaryService.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src/services/SnippetService.ts")), false);
  assert.doesNotMatch(read("src/stores/settingsStore.ts"), /syncDictionaryNow|syncSnippetsNow|import\(.*SyncService/);

  for (const file of [
    "src/components/DictionaryView.tsx",
    "src/components/SnippetsView.tsx",
    "src/services/tools/dictionaryTool.ts",
    "src/services/tools/snippetTool.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} must remain local`);
  }
  assert.match(read("src/stores/settingsStore.ts"), /customDictionary:/);
  assert.match(read("src/stores/settingsStore.ts"), /snippets:/);
  assert.match(read("src/services/tools/index.ts"), /snippetTool/);
});
