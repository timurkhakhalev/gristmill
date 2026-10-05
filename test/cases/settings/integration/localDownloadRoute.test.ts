// Issue #182 regression that bites: the On-device Download button must not carry
// a selection callback. This renders the real LocalRow button with a stub
// inventory whose download() invokes any second argument, exactly as the old
// success path did. Restoring the pre-PR button callback therefore moves the
// task route and fails the test; the current button passes only the entry, so
// the route it never asked to change stays put.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} from "../../../lib/rendererTestHarness";
import type {
  LocalModelEntry,
  LocalModelInventory,
} from "../../../../src/components/settings/models/inventoryContext";
import type { ModelTask } from "../../../../src/components/settings/models/taskModels";

const ENTRY: LocalModelEntry = {
  id: "base",
  kind: "whisper",
  organization: "whisper",
  name: "Base",
  size: "142 MB",
  recommended: false,
  downloaded: false,
};

// The download button is the trailing <button> whose children include the
// Download icon element. LocalRow returns an <OptionRow> whose `trailing` prop
// holds it, so walk every prop value, not just children.
function findDownloadButton(tree: unknown): { props: { onClick(): void } } | null {
  if (Array.isArray(tree)) {
    for (const item of tree) {
      const found = findDownloadButton(item);

      if (found) return found;
    }

    return null;
  }

  if (!tree || typeof tree !== "object") return null;
  const node = tree as { props?: Record<string, unknown> };

  if (typeof node.props?.onClick === "function" && hasDownloadIcon(node.props.children)) {
    return node as { props: { onClick(): void } };
  }

  return (
    Object.values(node.props ?? {})
      .map(findDownloadButton)
      .find(Boolean) ?? null
  );
}

// The t mock returns the key as text, so the download button's label child is
// the string "common.download"; its Download icon is a child element too.
function hasDownloadIcon(children: unknown): boolean {
  if (typeof children === "string") return children.toLowerCase().includes("download");

  if (Array.isArray(children)) return children.some(hasDownloadIcon);

  if (!children || typeof children !== "object") return false;
  const element = children as { type?: unknown; props?: Record<string, unknown> };

  const name =
    typeof element.type === "function"
      ? element.type.name
      : ((element.type as { displayName?: string } | undefined)?.displayName ?? "");

  if (name.toLowerCase().includes("download")) return true;

  return Object.values(element.props ?? {}).some(hasDownloadIcon);
}

async function mountRow(
  t: TestContext,
  task: ModelTask,
  entry: LocalModelEntry,
  inventory: LocalModelInventory
) {
  installBrowserGlobals(t, { window: { location: { search: "" } } });
  const container = installHookDom(t);

  const vite = await createRendererServer(t, {
    cachePrefix: "local-download-route-",
    mockModules: {
      "react-i18next": `export function useTranslation(){return {t:(k,o)=>o?.defaultValue??k};}`,
      "/utils/providerIcons": `export const getProviderIcon = () => null; export function isMonochromeProvider(){return false;} export default {};`,
      "@heroui/react": `const passthrough = ({children}) => children ?? null; export const Popover = ({children}) => children ?? null; export const Pressable = ({children}) => children ?? null;`,
    },
  });

  // Local structural types: casting to typeof import(...) would drag the
  // renderer's @/ alias graph into the test tsconfig, which has no such alias.
  const { LocalRow } = (await vite.ssrLoadModule(
    "/components/settings/models/TaskModelPicker.tsx"
  )) as {
    LocalRow: (props: {
      task: ModelTask;
      entry: LocalModelEntry;
      selected: boolean;
    }) => React.ReactElement;
  };

  const { InventoryContext } = (await vite.ssrLoadModule(
    "/components/settings/models/inventoryContext.ts"
  )) as {
    InventoryContext: {
      Provider: React.ComponentType<{ value: LocalModelInventory; children?: React.ReactNode }>;
    };
  };

  const { useSettingsStore } = (await vite.ssrLoadModule("/stores/settingsStore.ts")) as {
    useSettingsStore: {
      getState(): Record<string, unknown>;
      setState(value: Record<string, unknown>): void;
    };
  };

  const taskModels = (await vite.ssrLoadModule("/components/settings/models/taskModels.ts")) as {
    selectCloudModel(task: ModelTask, providerId: string, modelId: string): void;
    selectBb(
      task: "chatIntelligence",
      selection: { provider: string; model: string; reasoningLevel: string } | null
    ): void;
    selectSelfHosted(task: ModelTask, modelId?: string): void;
  };

  let tree: React.ReactElement | null = null;
  const root = createRoot(container as unknown as Element);
  const { Provider } = InventoryContext;
  await React.act(async () => {
    root.render(
      React.createElement(
        Provider,
        { value: inventory },
        React.createElement(function Harness() {
          // Call as a plain function so the captured tree is LocalRow's rendered
          // output (including the trailing Download button), not the LocalRow
          // element React would expand afterwards.
          tree = (
            LocalRow as unknown as (props: {
              task: ModelTask;
              entry: LocalModelEntry;
              selected: boolean;
            }) => React.ReactElement
          )({ task, entry, selected: false });

          return tree;
        })
      )
    );
    await new Promise((resolve) => setImmediate(resolve));
  });

  // Unmount inside the test body: the harness restores window/document before
  // any t.after registered later would run.
  const unmount = async () => {
    await React.act(async () => root.unmount());
  };

  return { store: useSettingsStore, taskModels, tree: () => tree, unmount };
}

// A stub inventory that, like the old auto-select path, runs a selection
// callback when one is passed. With the fix the button passes none.
function autoSelectingInventory(): {
  inventory: LocalModelInventory;
  calledWithCallback: () => boolean;
} {
  let sawCallback = false;

  const inventory = {
    speech: [],
    language: [],
    sherpaSupported: true,
    find: () => undefined,
    downloadState: () => null,
    download: (_entry: LocalModelEntry, onDownloaded?: (id: string) => void) => {
      if (onDownloaded) {
        sawCallback = true;
        onDownloaded(_entry.id);
      }
    },
    cancel: () => {},
    remove: () => {},
  } as LocalModelInventory;

  return { inventory, calledWithCallback: () => sawCallback };
}

for (const task of ["meeting", "upload"] as const) {
  test(`${task}: the On-device Download button leaves the selected Cloud route`, async (t) => {
    const { inventory, calledWithCallback } = autoSelectingInventory();
    const { store, taskModels, tree, unmount } = await mountRow(t, task, ENTRY, inventory);
    const seeded = store.getState();
    t.after(() => store.setState(seeded));

    try {
      taskModels.selectCloudModel(task, "deepgram", "nova-3");
      const prefix = task === "meeting" ? "meeting" : "upload";
      assert.equal(store.getState()[`${prefix}TranscriptionMode`], "providers");

      const button = findDownloadButton(tree());
      assert.ok(button, "the row renders a Download button");
      button!.props.onClick();

      const next = store.getState();
      assert.equal(
        next[`${prefix}TranscriptionMode`],
        "providers",
        "the Cloud route survives the download"
      );
      assert.equal(next[`${prefix}CloudTranscriptionProvider`], "deepgram");
      assert.equal(next[`${prefix}CloudTranscriptionModel`], "nova-3");
      assert.equal(calledWithCallback(), false, "the button must not pass a selection callback");
    } finally {
      await unmount();
    }
  });
}

// R182-2: the other sources a language task offers. The download button must
// leave the selected BB or Self-hosted route untouched too, not just Cloud.
const LANGUAGE_ENTRY: LocalModelEntry = {
  id: "qwen2.5-3b",
  kind: "llm",
  organization: "qwen",
  name: "Qwen2.5 3B",
  size: "1.9 GB",
  recommended: false,
  downloaded: false,
};

for (const source of ["bb", "self-hosted", "cloud"] as const) {
  test(`language task: the On-device Download button leaves the selected ${source} route`, async (t) => {
    const { inventory, calledWithCallback } = autoSelectingInventory();

    const { store, taskModels, tree, unmount } = await mountRow(
      t,
      "chatIntelligence",
      LANGUAGE_ENTRY,
      inventory
    );

    const seeded = store.getState();
    t.after(() => store.setState(seeded));

    try {
      if (source === "cloud")
        taskModels.selectCloudModel("chatIntelligence", "openai", "gpt-4o-mini");
      else if (source === "bb")
        taskModels.selectBb("chatIntelligence", {
          provider: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
        });
      else taskModels.selectSelfHosted("chatIntelligence", "llama-3.1-8b");

      const readMode = () => store.getState().chatAgentMode;
      const before = readMode();
      assert.equal(typeof before, "string");

      const button = findDownloadButton(tree());
      assert.ok(button, "the row renders a Download button");
      button!.props.onClick();

      assert.equal(readMode(), before, `the ${source} route survives the download`);
      assert.equal(calledWithCallback(), false, "the button must not pass a selection callback");
    } finally {
      await unmount();
    }
  });
}
