import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} from "../../../lib/rendererTestHarness.ts";

const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("Note/run output ignores late identities, superseded refreshes and unmounted responses", async (t) => {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await act(async () => root!.unmount());
  });

  const pending: Array<{
    request: { noteId: number; scope: string; runId?: string };
    resolve: (value: unknown) => void;
  }> = [];

  let updated!: (note: { id: number }) => void;
  let unsubscriptions = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNoteOutput: (request: { noteId: number; scope: string; runId?: string }) =>
          new Promise((resolve) => pending.push({ request, resolve })),
        onMeetingProcessingUpdated: () => () => {
          unsubscriptions++;
        },
        onNoteUpdated: (callback: typeof updated) => {
          updated = callback;

          return () => {
            unsubscriptions++;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "note-output-hook-" });

  const { useNoteOutput } = (await vite.ssrLoadModule(
    "/hooks/useNoteOutput.ts"
  )) as typeof import("../../../../src/hooks/useNoteOutput.ts");

  root = createRoot(container as unknown as Element);
  let props = { noteId: 1, runId: RUN_A, enabled: true };
  let state!: ReturnType<typeof useNoteOutput>;
  const readState = () => state;

  function Harness() {
    state = useNoteOutput(props.noteId, props.runId, props.enabled);

    return null;
  }

  const render = async () => {
    await act(async () => root!.render(createElement(Harness)));
  };

  const settle = async (index: number, marker: string) => {
    await act(async () => {
      for (const entry of pending.slice(index, index + 2))
        entry.resolve({ ...entry.request, diagnostics: [marker], result: null, summary: null });
    });
  };

  await render();
  assert.equal(pending.length, 2);
  props = { noteId: 2, runId: RUN_B, enabled: true };
  await render();
  assert.equal(readState().run, null);
  assert.equal(readState().loading, true);
  await settle(2, "new note");
  assert.equal(readState().run?.runId, RUN_B);
  await settle(0, "old note");
  assert.deepEqual(readState().run?.diagnostics, ["new note"]);
  await act(async () => updated({ id: 2 }));
  await act(async () => updated({ id: 2 }));
  await settle(6, "newest refresh");
  await settle(4, "older refresh");
  assert.deepEqual(readState().run?.diagnostics, ["newest refresh"]);
  await act(async () => updated({ id: 1 }));
  assert.equal(pending.length, 8);
  props = { noteId: 2, runId: RUN_A, enabled: true };
  await render();
  assert.equal(readState().run, null);
  assert.equal(readState().loading, true);
  await act(async () => {
    pending[8].resolve({ scope: "note", noteId: 2 });
    pending[9].resolve({ scope: "run", noteId: 2, runId: RUN_B });
  });
  assert.match(readState().error ?? "", /identity/);
  props = { noteId: 2, runId: RUN_A, enabled: false };
  await render();
  assert.equal(readState().loading, false);
  assert.equal(readState().run, null);
  assert.equal(unsubscriptions, 6);
  props = { noteId: 2, runId: RUN_A, enabled: true };
  await render();
  await act(async () => root!.unmount());
  root = null;
  const before = state;
  await settle(10, "after unmount");
  assert.equal(state, before);
  assert.equal(unsubscriptions, 8);
});
