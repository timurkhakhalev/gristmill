const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const setWindow = (value: unknown) => {
  (globalThis as { window?: unknown }).window = value;
};

test("search_notes uses local FTS IPC and does not expose semantic search", async () => {
  const { createSearchNotesTool } = await import("../../src/services/tools/searchNotesTool.js");
  const calls: unknown[][] = [];
  let semanticSearchCalled = false;
  setWindow({
    electronAPI: {
      searchNotes: async (...args: unknown[]) => {
        calls.push(args);

        return [
          {
            id: 12,
            title: "Launch plan",
            created_at: "2026-09-14T10:00:00.000Z",
            note_type: "note",
            content: "Ship the first release",
            enhanced_content: null,
          },
        ];
      },
      semanticSearchNotes: async () => {
        semanticSearchCalled = true;
        throw new Error("semantic search must not be called");
      },
    },
  });

  const tool = createSearchNotesTool({});
  assert.equal(tool.name, "search_notes");
  assert.match(tool.description, /Search all local notes/);
  assert.doesNotMatch(tool.description, /semantic/i);

  const result = await tool.execute({ query: "release", limit: 3 });

  assert.deepEqual(calls, [["release", 3, null, false]]);
  assert.equal(semanticSearchCalled, false);
  assert.deepEqual(result.data, [
    {
      id: 12,
      title: "Launch plan",
      date: "2026-09-14T10:00:00.000Z",
      type: "note",
      content: "Ship the first release",
    },
  ]);

  await createSearchNotesTool({ fixedScope: { folderId: null } }).execute({ query: "release" });
  assert.deepEqual(calls[1], ["release", 5, null, true]);
});

test("the tool registry never registers web_search", async () => {
  const { createToolRegistry } = await import("../../src/services/tools/index.js");
  const registry = createToolRegistry({ calendarConnected: true });

  assert.equal(registry.get("web_search"), undefined);
  assert.ok(registry.get("search_notes"));
  assert.ok(registry.get("get_calendar_events"));
});
