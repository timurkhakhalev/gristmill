import test from "node:test";
import assert from "node:assert/strict";
import { getNoteTool } from "../../../../src/services/tools/getNoteTool.ts";
import { installBrowserGlobals } from "../../../lib/rendererTestHarness.ts";

test("get_note keeps projection/manual text and metadata semantics through the persisted read owner", async (t) => {
  let summary: string | null = "edited Summary";
  let requests = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async (id: number) =>
          id === 7
            ? {
                id,
                title: "Meeting",
                note_type: "meeting",
                folder_id: 3,
                created_at: "created",
                updated_at: "updated",
              }
            : null,
        getNoteOutput: async (request: { noteId: number; scope: string }) => {
          requests++;
          assert.deepEqual(request, { noteId: 7, scope: "note" });
          return { noteId: 7, scope: "note", summary, manual: { text: "manual text" } };
        },
      },
    },
  });
  const result = await getNoteTool.execute({ id: 7 });
  assert.deepEqual(result.data, {
    id: 7,
    title: "Meeting",
    content: "edited Summary",
    type: "meeting",
    folder_id: 3,
    created_at: "created",
    updated_at: "updated",
  });
  summary = null;
  assert.equal(
    ((await getNoteTool.execute({ id: 7 })).data as { content: string }).content,
    "manual text"
  );
  assert.equal((await getNoteTool.execute({ id: 8 })).displayText, "Note with ID 8 not found");
  assert.equal(requests, 2);
});
