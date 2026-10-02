import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createRendererServer, installBrowserGlobals, installHookDom } from "../../../lib/rendererTestHarness.ts";
import type { CompanionStatus } from "../../../../src/contracts/companion.ts";
interface UiNode { props?: { children?: unknown; onClick?: () => unknown; [key: string]: unknown } }
function findUiNode(value: unknown, predicate: (node: UiNode) => boolean): UiNode | undefined {
  if (Array.isArray(value)) { for (const child of value) { const found = findUiNode(child, predicate); if (found) return found; } return; }
  if (!value || typeof value !== "object" || !("props" in value)) return;
  const node = value as UiNode;
  return predicate(node) ? node : findUiNode(node.props?.children, predicate);
}
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function mount(t: import("node:test").TestContext, component: string, api: Record<string, unknown> = {}) {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => { if (root) await act(async () => root!.unmount()); });
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "meet-ui-", mockModules: {
    "/stores/meetingRecordingStore": `export const state = { manualMicMuted: false, platformMicMuted: true, capturePhase: "recording", recordingId: "${UUID}", isRecording: true }; export const useMeetingRecordingStore = selector => selector(state); export const getActiveRecordingSessionId = () => "${UUID}"; export const setManualMicMuted = async value => { state.manualMicMuted = value; return true; };`,
    "react-i18next": `export const useTranslation = () => ({ t: key => key });`,
  } });
  const module = await vite.ssrLoadModule(component);
  const Component = Object.values(module)[0] as () => ReactNode;
  // The shared hook fixture implements the DOM methods React uses.
  root = createRoot(container as unknown as Element);
  let tree: ReactNode;
  function Harness() { tree = Component(); return tree; }
  await act(async () => { root!.render(createElement(Harness)); await Promise.resolve(); });
  return { text: () => container.textContent, node: (predicate: (node: UiNode) => boolean) => findUiNode(tree, predicate),
    click: async (node: UiNode | undefined) => { assert.ok(node?.props?.onClick); await act(async () => { await node.props!.onClick!(); }); } };
}

test("manual mic button works without Meet API and does not promise unmute while platform is muted", async (t) => {
  const ui = await mount(t, "/components/notes/MeetingMicButton.tsx");
  const mute = ui.node((node) => node.props?.["aria-label"] === "meetIntegration.mute");
  assert.equal(mute?.props?.["aria-pressed"], false);
  assert.match(String(mute?.props?.title), /platformMuted/);
  await ui.click(mute);
  const unmute = ui.node((node) => node.props?.["aria-label"] === "meetIntegration.unmute");
  assert.equal(unmute?.props?.["aria-pressed"], true);
  await ui.click(unmute);
  assert.match(String(ui.node((node) => node.props?.["aria-label"] === "meetIntegration.mute")?.props?.title), /platformMuted/);
});

test("late call selection does nothing before click and rejects stale confirmation visibly", async (t) => {
  const calls: unknown[] = [];
  const status: CompanionStatus = { enabled: true, binding: null, contextUnavailableSince: null, contextReason: null, reminderShown: false,
    candidates: [{ connectionId: UUID, ref: { platform: "google-meet", installationId: UUID, sessionId: UUID, tabId: 1, documentId: UUID.replaceAll("-", "").toUpperCase(), callId: "abc-defg-hij" }, receivedAt: 0,
      context: { sourceNs: "1000", presence: "in-call", health: "recognized", reason: null, micMuted: true, mode: "standard", participants: [], activeParticipantIds: [], rosterComplete: false, confirmedLeave: false } }] };
  const ui = await mount(t, "/components/notes/MeetBindingControl.tsx", { getMeetCompanionStatus: async () => status,
    onMeetCompanionStatus: () => () => {}, confirmMeetCompanionBinding: async (request: unknown) => { calls.push(request); return { success: false }; } });
  assert.equal(calls.length, 0);
  assert.match(ui.text() ?? "", /confirmDescription/);
  await ui.click(ui.node((node) => typeof node.props?.onClick === "function"));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { expected: { recordingId: UUID, sessionId: UUID }, candidate: { connectionId: UUID, ref: status.candidates[0].ref } });
  assert.match(ui.text() ?? "", /staleSelection/);
});

test("setup failure stays visible and does not report integration enabled", async (t) => {
  const actions: unknown[] = [];
  const ui = await mount(t, "/components/settings/MeetIntegrationSettings.tsx", { getMeetIntegrationSetup: async () => ({ enabled: false, installed: false, extensionPath: "/isolated/extension", channel: "development" }),
    configureMeetIntegration: async (action: unknown) => { actions.push(action); return { success: false, error: "Owned profile mismatch" }; } });
  await ui.click(ui.node((node) => node.props?.children === "meetIntegration.enable"));
  assert.deepEqual(actions, ["enable"]);
  assert.match(ui.text() ?? "", /Owned profile mismatch/);
  assert.match(ui.text() ?? "", /meetIntegration.disabled/);
});
