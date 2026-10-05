const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const React: typeof import("react") = require("react");

const { createRoot }: typeof import("react-dom/client") = require("react-dom/client");

const { createRendererServer, installBrowserGlobals, installHookDom } =
  require("../../../lib/rendererTestHarness.ts") as typeof import("../../../lib/rendererTestHarness.js");

type CompanionState = import("../../../../src/contracts/meetingCompanion.js").MeetingCompanionState;

type ReactNode = import("react").ReactNode;

test("quiet system-audio levels move companion bars above rest, while pause stays still", async (t) => {
  let onLevel: (level: number) => void = () => {};

  let onState: (state: CompanionState) => void = () => {};

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onMeetingCompanionLevel: (callback: typeof onLevel) => {
          onLevel = callback;

          return () => {};
        },
        onMeetingCompanionState: (callback: typeof onState) => {
          onState = callback;

          return () => {};
        },
        meetingCompanionReady: () => {},
      },
    },
  });
  const container = installHookDom(t);

  const vite = await createRendererServer(t, {
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t: (key) => key }; }`,
    },
  });

  const { default: Companion } = await vite.ssrLoadModule("/components/MeetingCompanion.tsx");
  let tree: ReactNode;

  const Harness = () => {
    tree = Companion();

    return tree;
  };

  const heights = (): number[] => {
    const found: number[] = [];

    const visit = (node: ReactNode): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);

        return;
      }

      if (!React.isValidElement<{ style?: { height?: string }; children?: ReactNode }>(node))
        return;

      if (node.props.style?.height) found.push(parseFloat(node.props.style.height));
      visit(node.props.children);
    };

    visit(tree);

    return found;
  };

  // The shared fake DOM supplies the container operations used by React.
  const root = createRoot(container as unknown as HTMLElement);

  try {
    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
    const resting = heights();
    assert.equal(resting.length, 3);
    await React.act(async () => {
      onLevel(0.0035);
    });
    const quiet = heights();
    assert.ok(
      quiet.every((height, i) => height > resting[i]),
      "quiet captured audio must not disappear below the resting floor"
    );
    await React.act(async () => {
      onLevel(1);
    });
    assert.ok(heights().every((height, i) => height > quiet[i] && height <= 100));
    await React.act(async () => {
      onState({
        active: true,
        paused: true,
        waitingForMic: false,
        micMuted: false,
        noteId: 1,
        folderId: null,
        title: "Meeting",
      });
    });
    assert.deepEqual(heights(), resting);
    await React.act(async () => {
      onLevel(0);
    });
    assert.deepEqual(heights(), resting);
  } finally {
    await React.act(async () => {
      root.unmount();
    });
  }
});
