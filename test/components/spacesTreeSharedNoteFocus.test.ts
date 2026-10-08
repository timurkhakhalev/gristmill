// Issue #147: a note living in two folders  rendered two rows that
// shared the `n:<noteId>` focus key, so the second placement overwrote the
// first in rowRefs, findIndex always picked the first placement, and both rows
// computed the same roving tabIndex. The fix keys every visible row by its
// container (`<containerKey>:n:<noteId>`), so each placement is independently
// focusable and parent navigation targets the current placement's folder.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const React = require("react");

const { createRoot } = require("react-dom/client");

const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness.ts");

import type { ReactNode } from "react";

type TestContext = import("node:test").TestContext;

type ViteDevServer = import("vite").ViteDevServer;

interface ReactNodeLike {
  key?: string | null;
  props?: Record<string, unknown> & { children?: unknown };
}

interface RowA11yLike {
  tabIndex: number;
  onFocus: () => void;
  onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
}

interface RowProbe {
  key: string;
  title: string;
  a11y: RowA11yLike;
  isFolder: boolean;
}

interface TreeState {
  expanded: Set<string>;
  folders: Array<{ id: number; name: string; is_default: number }>;
  notesByContainer: Record<string, Array<{ id: number; title: string }>>;
  openedNoteId: number | null;
  activeFolderId: number | null;
}

const GLOBAL_STATE_KEY = "__spacesTreeSharedNoteFocusState";

const baseState = (): TreeState & { notes: Array<{ id: number; title: string }> } => {
  const notes = [
    { id: 201, title: "Shared note" },
    { id: 301, title: "Root note" },
  ];

  return {
    notes,
    folders: [
      { id: 11, name: "Folder A", is_default: 0 },
      { id: 22, name: "Folder B", is_default: 0 },
    ],
    expanded: new Set(["root", "folder:11", "folder:22"]),
    notesByContainer: {
      "folder:11": [notes[0]],
      "folder:22": [notes[0]],
      "root": [notes[1]],
    },
    openedNoteId: null,
    activeFolderId: null,
  };
};

const noteStoreMock = `
  const state = () => globalThis[${JSON.stringify(GLOBAL_STATE_KEY)}];
  export const folderContainerKey = (id) => "folder:" + id;
  export const ROOT_CONTAINER_KEY = "root";
  export const useFolders = () => state().folders;
  export const useFolderCounts = () => ({ 11: 1, 22: 1, 33: 1 });
  export const useRootNoteCount = () => 1;
  export const useNotesByContainer = () => state().notesByContainer;
  export const useExpandedContainers = () => state().expanded;
  export const useActiveContext = () => null;
  export const useActiveNoteId = () => null;
  export const useIsTreeLoading = () => false;
  export const getNoteFromStore = (id) => state().notes.find((note) => note.id === id);
  export const setActiveContext = (folderId) => { state().activeFolderId = folderId; };
  export const setActiveNoteId = (id) => { state().openedNoteId = id; };
  export const setContainerExpanded = () => {};
  export const toggleContainerExpanded = () => {};
  export const createFolder = async () => ({ success: true });
  export const renameFolder = async () => ({ success: true });
  export const updateFolderStyle = async () => ({ success: true });
  export const reorderFolders = async () => {};
  export const deleteFolder = async () => ({ success: true });
`;

const MOCK_MODULES = {
  "/stores/noteStore": noteStoreMock,
  "/hooks/useNoteDragAndDrop": `
    export const useNoteDragAndDrop = () => ({
      dragState: { draggingNoteId: null, dragOverKey: null, dropSuccessKey: null },
      noteDragHandlers: () => ({ draggable: true, onDragStart: () => {}, onDragEnd: () => {} }),
      dropTargetHandlers: () => ({ onDragOver: () => {}, onDragEnter: () => {}, onDragLeave: () => {}, onDrop: () => {} }),
    });
  `,
  "/hooks/useDialogs": `
    export const useDialogs = () => ({
      confirmDialog: { open: false },
      showConfirmDialog: () => {},
      hideConfirmDialog: () => {},
    });
  `,
  "/ui/useToast": `export const useToast = () => ({ toast: () => "toast", dismiss: () => {} });`,
  "/stores/settingsStore": `export const useSettingsStore = (selector) => selector({ noteFilesEnabled: false });`,
  "/stores/meetingRecordingStore": `
    const state = { capturePhase: "idle", recordingNoteId: null };
    export const useMeetingRecordingStore = (selector) => selector(state);
    export async function stopRecording() { return { stopped: true }; }
  `,
  "/components/icons": `
    const icon = () => null;
    export const AudioLines = icon; export const Check = icon; export const ChevronDown = icon;
    export const ChevronRight = icon; export const ExternalLink = icon; export const FileText = icon;
    export const Folder = icon; export const FolderOpen = icon; export const Loader2 = icon;
    export const MoreHorizontal = icon; export const Pencil = icon; export const Plus = icon;
    export const Smile = icon; export const Trash2 = icon; export const X = icon;
  `,
  "/components/ui/button": `
    import React from "react";
    export const Button = (props) => React.createElement("button", {
      onClick: props.onClick, "aria-label": props["aria-label"], title: props.title,
    }, props.children);
  `,
  "/components/ui/popover": `
    const passthrough = ({ children }) => children;
    export const Popover = passthrough;
    export const PopoverAnchor = passthrough;
    export const PopoverContent = () => null;
  `,
  "/components/ui/dialog": `
    const empty = () => null;
    export { empty as ConfirmDialog, empty as Dialog, empty as DialogContent,
      empty as DialogHeader, empty as DialogTitle };
  `,
  "@heroui/react": `
    import React from "react";
    const passthrough = (props) => props.children;
    const Dropdown: Record<string, unknown> = (props: { children?: unknown }) => props.children;
    Dropdown.Trigger = (props: Record<string, unknown>) => React.createElement("button", props);
    Dropdown.Popover = passthrough; Dropdown.Menu = passthrough; Dropdown.Item = passthrough;
    Dropdown.SubmenuTrigger = passthrough; Dropdown.SubmenuIndicator = () => null;
    export { Dropdown };
    export const Label = passthrough;
    export const Separator = () => null;
  `,
  "react-i18next": `
    // One frozen i18n shared by every render: if dir ever went missing the
    // probe below would show it, and freeze() stops any code mutating it.
    const I18N = Object.freeze({ dir: () => "ltr", resolvedLanguage: "en", language: "en" });
    const probe = () => (globalThis.__spacesTreeI18nProbe ??= []);
    export function useTranslation() {
      const log = probe();
      log.push({ dirType: typeof I18N.dir, keys: Object.keys(I18N) });
      if (log.length > 50) log.shift();
      return { t: (key) => key, i18n: I18N };
    }
  `,
};

let vitePromise: Promise<ViteDevServer> | undefined;

const cleanup: Array<() => void | Promise<void>> = [];

test.after(async () => {
  for (const close of cleanup) await close();
});

function findNodes(node: unknown, predicate: (node: ReactNodeLike) => boolean): ReactNodeLike[] {
  if (Array.isArray(node)) return node.flatMap((item) => findNodes(item, predicate));

  if (!node || typeof node !== "object") return [];
  const element = node as ReactNodeLike;
  const found = predicate(element) ? [element] : [];
  const children = (element.props as { children?: unknown } | undefined)?.children;

  return [...found, ...findNodes(children, predicate)];
}

const rowsIn = (tree: unknown): RowProbe[] =>
  findNodes(tree, (node) => Boolean(node.props?.a11y)).map((node) => {
    const props = node.props as {
      a11y: RowA11yLike;
      note?: { title: string };
      folder?: { name: string };
    };

    return {
      key: node.key ?? "",
      title: props.folder?.name ?? props.note?.title ?? "",
      a11y: props.a11y,
      isFolder: Boolean(props.folder),
    };
  });

function row(rows: RowProbe[], key: string): RowProbe {
  const match = rows.find((candidate) => candidate.key === key);
  assert.ok(match, `row ${key} is rendered`);

  return match;
}

const focusedRow = (rows: RowProbe[]): RowProbe => {
  const match = rows.filter((candidate) => candidate.a11y.tabIndex === 0);
  assert.equal(
    match.length,
    1,
    `exactly one row holds the roving tabIndex (got ${match.map((r) => r.key).join(", ") || "none"})`
  );

  return match[0]!;
};

// One settled render pass: an act that re-renders and lets every effect —
// including the retarget effect's own setState — flush before returning, so
// tree() is never read from a partially-flushed render.
async function flushTwice(ui: { rerender: () => Promise<void> }): Promise<void> {
  await ui.rerender();
  await ui.rerender();
}

/** Presses a key, then settles: rows are re-read only after the flush lands. */
async function pressAndSettle(
  ui: { tree: () => unknown; rerender: () => Promise<void> },
  probe: RowProbe,
  key: string
): Promise<RowProbe[]> {
  await React.act(async () => {
    probe.a11y.onKeyDown({ key, preventDefault() {} });
  });
  await flushTwice(ui);

  return rowsIn(ui.tree());
}

/** Mounts the real NotesTree against the shared mutable tree state. */
async function mountTree(t: TestContext) {
  // Unmount must be the first hook registered: cleanup runs before the
  // browser-global teardown removes `window`, which react-dom touches on unmount.
  let unmountTree: () => Promise<void> = async () => {};

  t.after(() => unmountTree());
  installBrowserGlobals(t);
  const container = installHookDom(t);

  const vite = await (vitePromise ??= createRendererServer(
    { after: (close: () => void | Promise<void>) => cleanup.push(close) } as unknown as TestContext,
    {
      cachePrefix: "openwhispr-spaces-tree-shared-note-focus-",
      mockModules: MOCK_MODULES,
      // vite SSR externalizes react-i18next by default, which bypasses the
      // mock and serves the real package nondeterministically (missing dir).
      noExternal: ["react-i18next"],
    }
  ));

  const { default: NotesTree } = await vite.ssrLoadModule("/components/notes/NotesTree.tsx");
  let tree: unknown;
  let rerender: () => void = () => {};

  function Harness() {
    const [, tick] = React.useState(0);
    rerender = () => tick((n: number) => n + 1);
    tree = (NotesTree as (props: Record<string, unknown>) => unknown)({
      onDeleteNote: () => {},
      onMoveNote: async () => null,
      onCreateFolderAndMove: () => {},
      onNewNote: async () => null,
    });

    return tree as ReactNode;
  }

  const root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  unmountTree = async () => {
    await React.act(async () => root.unmount());
  };

  return {
    tree: () => tree,
    rerender: async () => {
      await React.act(async () => rerender());
    },
  };
}

const sharedState = () => (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY] as TreeState;

const setState = (patch: Partial<TreeState>) => {
  (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY] = {
    ...sharedState(),
    ...patch,
  };
};

test("one note in two folders renders two independently focusable placements", async (t: TestContext) => {
  (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY] = baseState();
  t.after(() => {
    delete (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY];
  });
  const ui = await mountTree(t);

  const rows = rowsIn(ui.tree());
  assert.deepEqual(
    rows.map((candidate) => candidate.key),
    ["11", "folder:11:n:201", "22", "folder:22:n:201", "root:n:301"],
    "both placements of the shared note are separate rows in tree order"
  );
  // Before any keyboard interaction the first row owns the roving tabIndex;
  // the second placement of the shared note must not carry one too.
  assert.equal(rows.filter((candidate) => candidate.a11y.tabIndex === 0).length, 1);

  // The i18n mock is actually the one served (noExternal keeps vite from
  // externalizing react-i18next): every useTranslation call saw dir.
  const probe = (globalThis as Record<string, unknown>).__spacesTreeI18nProbe as
    | Array<{ dirType: string; keys: string[] }>
    | undefined;

  assert.ok(probe && probe.length > 0, "react-i18next mock recorded useTranslation calls");
  assert.ok(
    probe.every((entry) => entry.dirType === "function" && entry.keys.includes("dir")),
    "i18n.dir stayed a function on every render"
  );
});

test("ArrowDown and ArrowUp traverse both placements of the shared note", async (t: TestContext) => {
  (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY] = baseState();
  t.after(() => {
    delete (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY];
  });
  const ui = await mountTree(t);

  // Tree order: 11, folder:11:n:201, 22, folder:22:n:201, root:n:301.
  let rows = await pressAndSettle(ui, row(rowsIn(ui.tree()), "folder:11:n:201"), "ArrowDown");
  assert.equal(focusedRow(rows).key, "22", "ArrowDown steps to the second folder row first");

  rows = await pressAndSettle(ui, row(rows, "22"), "ArrowDown");
  assert.equal(focusedRow(rows).key, "folder:22:n:201", "ArrowDown reaches the second placement");

  rows = await pressAndSettle(ui, row(rows, "folder:22:n:201"), "ArrowDown");
  assert.equal(
    focusedRow(rows).key,
    "root:n:301",
    "ArrowDown continues past the second placement"
  );

  rows = await pressAndSettle(ui, row(rows, "root:n:301"), "ArrowUp");
  assert.equal(focusedRow(rows).key, "folder:22:n:201", "ArrowUp returns to the second placement");

  rows = await pressAndSettle(ui, row(rows, "folder:22:n:201"), "ArrowUp");
  assert.equal(focusedRow(rows).key, "22", "ArrowUp steps back through the second folder row");

  rows = await pressAndSettle(ui, row(rows, "22"), "ArrowUp");
  assert.equal(focusedRow(rows).key, "folder:11:n:201", "ArrowUp returns to the first placement");
});

test("outward navigation from a placement focuses that placement's own folder", async (t: TestContext) => {
  (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY] = baseState();
  t.after(() => {
    delete (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY];
  });
  const ui = await mountTree(t);

  // Tree order: 11, folder:11:n:201, 22, folder:22:n:201, root:n:301.
  let rows = await pressAndSettle(ui, row(rowsIn(ui.tree()), "folder:11:n:201"), "ArrowDown");
  // The focused placement is inside Folder B; outward must target Folder B.
  rows = await pressAndSettle(ui, row(rows, "folder:22:n:201"), "ArrowLeft");
  assert.equal(focusedRow(rows).key, "22", "outward focuses the current placement's parent folder");

  // Inward from Folder B opens onto its own child placement again.
  rows = await pressAndSettle(ui, row(rows, "22"), "ArrowRight");
  assert.equal(focusedRow(rows).key, "folder:22:n:201", "inward focuses this folder's placement");
});

test("Enter on a placement opens the note itself", async (t: TestContext) => {
  const state = baseState();
  (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY] = state;
  t.after(() => {
    delete (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY];
  });
  const ui = await mountTree(t);

  await pressAndSettle(ui, row(rowsIn(ui.tree()), "folder:22:n:201"), "Enter");
  assert.equal(state.openedNoteId, 201, "Enter activates the note from either placement");
  assert.equal(state.activeFolderId, 22, "the opened placement keeps its folder context");
});

test("focus follows the note when one placement is collapsed or removed", async (t: TestContext) => {
  const state = baseState();
  (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY] = state;
  t.after(() => {
    delete (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY];
  });
  const ui = await mountTree(t);

  await React.act(async () => {
    row(rowsIn(ui.tree()), "folder:11:n:201").a11y.onFocus();
  });
  await flushTwice(ui);
  assert.equal(focusedRow(rowsIn(ui.tree())).key, "folder:11:n:201");

  // Collapse the focused placement's folder. Collapse is pure CSS on the
  // FolderRow wrapper, so the placement's JSX stays rendered; what must
  // change is the roving tabIndex (the rows memo drops the collapsed row,
  // which fires the retarget effect) and keyboard reachability.
  setState({ expanded: new Set(["root", "folder:22"]) });
  await flushTwice(ui);
  assert.equal(
    focusedRow(rowsIn(ui.tree())).key,
    "folder:22:n:201",
    "focus retargets to the surviving placement"
  );

  // The collapsed placement is out of keyboard order: ArrowUp from the
  // surviving placement lands on folder 22, never on the hidden row.
  let rows = await pressAndSettle(ui, row(rowsIn(ui.tree()), "folder:22:n:201"), "ArrowUp");
  assert.equal(focusedRow(rows).key, "22", "collapsed placement is skipped by keyboard order");

  rows = await pressAndSettle(ui, row(rows, "22"), "ArrowDown");
  assert.equal(
    focusedRow(rows).key,
    "folder:22:n:201",
    "ArrowDown returns to the surviving placement"
  );

  // Remove the note from Folder A while the folder stays expanded: now the
  // JSX row genuinely disappears (notesByContainer drops it).
  setState({
    expanded: new Set(["root", "folder:11", "folder:22"]),
    notesByContainer: { ...state.notesByContainer, "folder:11": [] },
  });
  await flushTwice(ui);
  const afterRemoval = rowsIn(ui.tree());
  assert.ok(
    !afterRemoval.some((candidate) => candidate.key === "folder:11:n:201"),
    "removed placement leaves the rendered rows"
  );
  assert.equal(
    focusedRow(afterRemoval).key,
    "folder:22:n:201",
    "focus stays on the surviving placement"
  );
});
