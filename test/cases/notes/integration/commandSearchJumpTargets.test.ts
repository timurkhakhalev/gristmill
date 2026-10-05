// Issue #178: CommandSearch loaded folders/spaces once at mount into local
// state while ControlPanel keeps it mounted with search closed — after a
// folder create/rename/delete the search's jump targets went stale. It now
// reads the live noteStore references (the same arrays createFolder/
// renameFolder/deleteFolder/loadFolders/loadSpaces write), so this regression
// mounts the real component, mutates the store through the real store
// actions, and asserts the rendered jump targets follow: a renamed folder is
// found by its new name, a deleted one disappears, a renamed space matches.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const path = require("node:path");

const React = require("react") as typeof import("react");

const { createRoot } = require("react-dom/client");

const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
}: typeof import("../../../lib/rendererTestHarness.ts") = require("../../../lib/rendererTestHarness.ts");

import type { FolderItem, SpaceItem } from "../../../../src/contracts/containers";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function folder(id: number, name: string, spaceId = 1): FolderItem {
  return { id, name, space_id: spaceId, is_default: false } as unknown as FolderItem;
}

function space(id: number, name: string, kind: "private" | "team" = "private"): SpaceItem {
  return { id, name, kind } as unknown as SpaceItem;
}

interface Harness {
  typeQuery(value: string): Promise<void>;
  targetLabels(): string[];
  fullText(): string;
  createFolder(name: string): Promise<void>;
  renameFolder(id: number, name: string): Promise<void>;
  deleteFolder(id: number): Promise<void>;
  renameSpace(id: number, name: string): Promise<void>;
}

async function mountSearch(
  t: import("node:test").TestContext,
  { folders: folderRows, spaces: spaceRows }: { folders: FolderItem[]; spaces: SpaceItem[] }
): Promise<Harness> {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      electronAPI: {
        // IPC-like serialization: fresh copies every read and every mutation
        // produces new row objects. Sharing live arrays with the component
        // would alias the store and defeat the stale-snapshot regression (an
        // in-place mutation would "fix" even the mount-only component).
        getFolders: async () => folderRows.map((row) => ({ ...row })),
        createFolder: async (name: string, spaceId: number) => {
          const created = folder(folderRows.length + 1, name, spaceId);
          folderRows.push(created);

          return { success: true, folder: { ...created } };
        },
        renameFolder: async (id: number, name: string) => {
          const target = folderRows.find((f) => f.id === id);

          if (target) (target as { name: string }).name = name;

          return { success: true, folder: target ? { ...target } : null };
        },
        deleteFolder: async (id: number) => {
          const idx = folderRows.findIndex((f) => f.id === id);

          if (idx >= 0) folderRows.splice(idx, 1);

          return { success: true };
        },
        updateSpace: async (id: number, updates: { name?: string }) => {
          const target = spaceRows.find((sp) => sp.id === id);

          if (target && updates.name != null) (target as { name: string }).name = updates.name;

          return { success: true, space: target ? { ...target } : null };
        },
        getFolderNoteCounts: async () => [],
        getSpaces: async () => spaceRows.map((row) => ({ ...row })),
        getNotes: async () => [],
        searchNotes: async () => [],
        searchNoteTranscripts: async () => [],
        onNoteAdded: () => () => {},
        onNoteUpdated: () => () => {},
        onNoteDeleted: () => () => {},
        onFolderDeleted: () => () => {},
      },
    },
  });
  const container = installHookDom(t);

  const mockModules: Record<string, string> = {
    "react-i18next": `
      const t = (key) => key;
      export const initReactI18next = { type: "3rdParty", init() {} };
      export function useTranslation() { return { t, i18n: { resolvedLanguage: "en" } }; }
    `,
    "@heroui/react": `
      import React from "react";
      const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
      export const Dropdown = Object.assign(passthrough, { Popover: passthrough, Menu: passthrough, Item: passthrough, ItemIndicator: passthrough, Trigger: passthrough });
      export const Label = passthrough;
      export const Separator = () => null;
      export const Modal = Object.assign(
        ({isOpen, children}) => isOpen ? React.createElement(React.Fragment, null, children) : null,
        { Backdrop: passthrough, Container: passthrough, Dialog: passthrough, CloseTrigger: passthrough, Header: passthrough, Heading: passthrough, Body: passthrough, Footer: passthrough }
      );
    `,
  };

  const vite = await createRendererServer(t, {
    mockModules,
    noExternal: ["react-i18next", "@heroui/react"],
    resolveAlias: { "@": path.resolve(__dirname, "../../../src") },
  });

  const { default: CommandSearch } = await vite.ssrLoadModule("/components/CommandSearch.tsx");

  const store = (await vite.ssrLoadModule(
    "/stores/noteStore.ts"
  )) as typeof import("../../../../src/stores/noteStore");

  await React.act(async () => {
    await store.initializeNotesTree();
  });

  // Calling the component as a function inside a real component keeps its
  // hooks intact while handing back the element tree, which the driver reads
  // and manipulates (the meetingResultsPanel harness pattern).
  const captured: { tree: unknown } = { tree: null };
  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    function Harness() {
      const rendered = CommandSearch({
        open: true,
        onOpenChange: () => {},
        onNoteSelect: () => {},
        onContainerSelect: () => {},
      }) as ReturnType<typeof CommandSearch>;

      captured.tree = rendered;

      return rendered;
    }

    root!.render(React.createElement(Harness));
    await tick();
  });

  const findNode = (
    node: unknown,
    predicate: (n: { props?: Record<string, unknown> }) => boolean
  ): { props?: Record<string, unknown> } | null => {
    if (Array.isArray(node))
      return node.map((item) => findNode(item, predicate)).find(Boolean) ?? null;

    if (!node || typeof node !== "object") return null;
    const n = node as { props?: Record<string, unknown> };

    if (predicate(n)) return n;

    for (const value of Object.values(n.props ?? {})) {
      const found = findNode(value, predicate);

      if (found) return found;
    }

    return null;
  };

  const findNodes = (
    node: unknown,
    predicate: (n: { props?: Record<string, unknown> }) => boolean
  ): Array<{ props?: Record<string, unknown> }> => {
    if (Array.isArray(node)) return node.flatMap((item) => findNodes(item, predicate));

    if (!node || typeof node !== "object") return [];
    const n = node as { props?: Record<string, unknown> };

    return [
      ...(predicate(n) ? [n] : []),
      ...Object.values(n.props ?? {}).flatMap((value) => findNodes(value, predicate)),
    ];
  };

  const textOf = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(textOf).join("");

    if (!value || typeof value !== "object")
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    const props = (value as { props?: { children?: unknown } }).props;

    return textOf(props?.children);
  };

  const input = findNode(
    captured.tree,
    (n) => typeof n.props?.onChange === "function" && n.props?.value === ""
  );

  assert.ok(input, "the search input is rendered");

  const typeQuery = async (value: string) => {
    await React.act(async () => {
      (input!.props!.onChange as (event: { target: { value: string } }) => void)({
        target: { value },
      });
      await tick();
    });
  };

  return {
    typeQuery,
    fullText: () => textOf(captured.tree),
    targetLabels: () =>
      findNodes(
        captured.tree,
        (n) => typeof n.props?.target === "object" && n.props?.target !== null
      ).map((row) => textOf((row.props?.target as { label: string }).label)),
    createFolder: async (name: string) => {
      await React.act(async () => {
        await store.createFolder(name, 1);
      });
    },
    renameFolder: async (id: number, name: string) => {
      await React.act(async () => {
        await store.renameFolder(id, name);
      });
    },
    deleteFolder: async (id: number) => {
      await React.act(async () => {
        await store.deleteFolder(id);
      });
    },
    renameSpace: async (id: number, name: string) => {
      await React.act(async () => {
        await store.updateSpaceMeta(id, { name });
      });
    },
  };
}

test("a folder created while search stays mounted is found by its new name", async (t) => {
  const harness = await mountSearch(t, {
    folders: [folder(1, "Work")],
    spaces: [space(1, "Personal")],
  });

  await harness.createFolder("Projects");
  await harness.typeQuery("proj");

  assert.deepEqual(
    harness.targetLabels(),
    ["Projects"],
    "the new folder is offered as a jump target"
  );
});

test("a renamed folder is found by the new name and not the old one", async (t) => {
  const harness = await mountSearch(t, {
    folders: [folder(1, "Reports")],
    spaces: [space(1, "Personal")],
  });

  await harness.renameFolder(1, "Client work");

  await harness.typeQuery("client");
  assert.deepEqual(harness.targetLabels(), ["Client work"]);

  await harness.typeQuery("reports");
  assert.deepEqual(harness.targetLabels(), [], "the old name no longer matches");
});

test("a deleted folder disappears from the jump targets", async (t) => {
  const harness = await mountSearch(t, {
    folders: [folder(1, "Work")],
    spaces: [space(1, "Personal")],
  });

  await harness.typeQuery("work");
  assert.deepEqual(harness.targetLabels(), ["Work"]);

  await harness.deleteFolder(1);
  // Re-type through an empty query: the same value alone skips the re-render.
  await harness.typeQuery("");
  await harness.typeQuery("work");

  assert.deepEqual(harness.targetLabels(), [], "the removed folder is no longer offered");
});

// A named (non-personal) space's label is its name; renaming it through the
// store must show the new name both as a jump target and in the scope
// switcher, which reads the same store references.
test("a space rename is reflected in jump targets and the scope switcher", async (t) => {
  const harness = await mountSearch(t, {
    folders: [folder(2, "Docs", 7)],
    spaces: [space(1, "Personal"), space(7, "Team", "team")],
  });

  await harness.typeQuery("team");
  assert.deepEqual(harness.targetLabels(), ["Team"]);

  await harness.renameSpace(7, "Squad");
  await harness.typeQuery("");
  await harness.typeQuery("squad");

  assert.deepEqual(
    harness.targetLabels(),
    ["Squad"],
    "the renamed space is offered under its new name"
  );

  // The scope switcher (space dropdown items) shows the new name too.
  const allText = JSON.stringify(harness.fullText());
  assert.ok(allText.includes("Squad"), "the scope switcher shows the renamed space");
  assert.ok(!allText.includes('"Team"'), "the old space name is gone from the switcher");
});
