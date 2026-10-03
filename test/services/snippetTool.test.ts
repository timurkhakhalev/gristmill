const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/services/tools/snippetTool.js");

import type { Snippet } from "../../src/utils/snippets.js";
const snippets: Snippet[] = [
  { trigger: "investor ask", replacement: "We are raising a $2M seed round." },
  { trigger: "Sign-off", replacement: "Best,\nGabe" },
];

test("the description lists every saved trigger so the model can pick one without a call", async () => {
  const { createSnippetTool } = await load();
  const tool = createSnippetTool(() => snippets);

  assert.equal(tool.name, "get_snippet");
  assert.equal(tool.readOnly, true);
  assert.match(tool.description, /Saved triggers: "investor ask", "Sign-off"\./);
  assert.doesNotMatch(tool.description, /seed round/);
});

test("a trigger resolves case-insensitively to its saved text", async () => {
  const { createSnippetTool } = await load();
  const tool = createSnippetTool(() => snippets);

  const result = await tool.execute({ trigger: " sign-off " });

  assert.deepEqual(result, {
    success: true,
    data: { trigger: "Sign-off", text: "Best,\nGabe" },
    displayText: 'Snippet "Sign-off"',
  });
});

test("an unknown trigger fails with the saved triggers so the model can retry", async () => {
  const { createSnippetTool } = await load();
  const tool = createSnippetTool(() => snippets);

  const result = await tool.execute({ trigger: "intro" });

  assert.equal(result.success, false);
  assert.equal(result.data, null);
  assert.equal(
    result.displayText,
    'No snippet with trigger "intro". Saved triggers: "investor ask", "Sign-off"'
  );
});

function vocabulary(current: Array<{ trigger: string; replacement: string }>) {
  const writes: unknown[] = [];
  return {
    writes,
    actions: {
      getDictionary: () => [],
      updateDictionary: () => {},
      getSnippets: () => current,
      setSnippets: (next: unknown) => writes.push(next),
    },
  };
}

test("registry exposes the vocabulary tools, and get_snippet only when snippets exist", async () => {
  const { createToolRegistry } = await import("../../src/services/tools/index.js");
  const settings = {
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
  };

  const withSnippets = createToolRegistry({
    ...settings,
    vocabulary: vocabulary(snippets).actions,
  });
  const withoutSnippets = createToolRegistry({ ...settings, vocabulary: vocabulary([]).actions });
  const noVocabulary = createToolRegistry(settings);

  assert.match(withSnippets.get("get_snippet")?.description ?? "", /"investor ask"/);
  assert.equal(withSnippets.get("update_dictionary")?.readOnly, false);
  assert.equal(withSnippets.get("update_snippets")?.readOnly, false);
  assert.equal(withoutSnippets.get("get_snippet"), undefined);
  assert.equal(withoutSnippets.get("update_snippets")?.readOnly, false);
  assert.equal(noVocabulary.get("update_dictionary"), undefined);
});

test("get_snippet reads the current snippets, not the registry-creation snapshot", async () => {
  const { createSnippetTool } = await load();
  let current = snippets;
  const getSnippets = () => current;
  const tool = createSnippetTool(getSnippets);

  const updated = await tool.execute({ trigger: "sign-off" });
  assert.equal((updated.data as { text: string }).text, "Best,\nGabe");

  current = [{ trigger: "Sign-off", replacement: "Warmly,\nGabe" }];
  const afterReplacement = await tool.execute({ trigger: "sign-off" });
  assert.equal((afterReplacement.data as { text: string }).text, "Warmly,\nGabe");
  assert.match(afterReplacement.displayText, /Snippet "Sign-off"/);

  current = [{ trigger: "investor ask", replacement: "We are raising a $2M seed round." }];
  const afterRemoval = await tool.execute({ trigger: "sign-off" });
  assert.equal(afterRemoval.success, false);
  assert.match(afterRemoval.displayText, /Saved triggers: "investor ask"/);
});

test("a real registry: update_snippets then get_snippet in the same loop returns the new text", async () => {
  const { createToolRegistry } = await import("../../src/services/tools/index.js");
  let current = snippets;
  const registry = createToolRegistry({
    calendarConnected: false,
    vocabulary: {
      getDictionary: () => [],
      updateDictionary: () => {},
      getSnippets: () => current,
      setSnippets: (next) => {
        current = next;
      },
    },
  });

  const update = await registry.get("update_snippets")?.execute({
    add: [{ trigger: "sign-off", replacement: "Cheers,\nGabe" }],
  });
  assert.equal(update?.success, true);

  const get = await registry.get("get_snippet")?.execute({ trigger: " sign-off " });
  assert.deepEqual(get, {
    success: true,
    data: { trigger: "sign-off", text: "Cheers,\nGabe" },
    displayText: 'Snippet "sign-off"',
  });
});

test("update_snippets replaces an existing trigger, adds a new one, and removes by trigger", async () => {
  const { createUpdateSnippetsTool } = await load();
  const { actions, writes } = vocabulary(snippets);
  const tool = createUpdateSnippetsTool(actions);

  const result = await tool.execute({
    add: [
      { trigger: "SIGN-OFF", replacement: "Cheers,\nGabe" },
      { trigger: "intro", replacement: "Hi, I'm Gabe." },
    ],
    remove: ["Investor Ask"],
  });

  assert.deepEqual(writes, [
    [
      { trigger: "SIGN-OFF", replacement: "Cheers,\nGabe" },
      { trigger: "intro", replacement: "Hi, I'm Gabe." },
    ],
  ]);
  assert.deepEqual(result.data, {
    added: ["intro"],
    replaced: ["Sign-off"],
    removed: ["investor ask"],
    notFound: [],
  });
  assert.equal(result.displayText, 'Added "intro"; Replaced "Sign-off"; Removed "investor ask"');
});

test("update_snippets refuses incomplete snippets and unknown triggers without writing", async () => {
  const { createUpdateSnippetsTool } = await load();
  const { actions, writes } = vocabulary(snippets);
  const tool = createUpdateSnippetsTool(actions);

  const incomplete = await tool.execute({ add: [{ trigger: "intro" }] });
  const tooLong = await tool.execute({ add: [{ trigger: "x".repeat(101), replacement: "y" }] });
  const unknown = await tool.execute({ remove: ["outro"] });

  assert.equal(writes.length, 0);
  assert.equal(incomplete.success, false);
  assert.equal(tooLong.success, false);
  assert.equal(unknown.success, false);
  assert.equal(unknown.displayText, 'No snippet with trigger "outro"');
});

test("the agent prompt tells the model when to fetch a snippet", async () => {
  const { getAgentSystemPrompt } = await import("../../src/config/prompts.js");

  const prompt = getAgentSystemPrompt(["get_snippet"]);

  assert.match(prompt, /Use get_snippet whenever the user names one of their saved snippets/);
  assert.match(prompt, /reproduce the returned text verbatim/);
  assert.doesNotMatch(getAgentSystemPrompt(["copy_to_clipboard"]), /get_snippet/);
  assert.doesNotMatch(prompt, /gristmill --help/);
});
