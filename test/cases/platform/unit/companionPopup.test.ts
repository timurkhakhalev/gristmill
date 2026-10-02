import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describePopup, popupDiagnostics, popupStatusSchema, type PopupStatus } from "../../../../extension/src/popupState.ts";

function fixture(): PopupStatus {
  const ref = { platform: "google-meet" as const, installationId: randomUUID(), sessionId: randomUUID(), tabId: 7,
    documentId: randomUUID().replaceAll("-", "").toUpperCase(), callId: "abc-defg-hij" };
  return { connected: true, error: "", canControlMic: true,
    snapshot: { version: 1, type: "snapshot", connectionId: randomUUID(), recordingState: "recording", recordingId: randomUUID(),
      binding: null, contextState: "unbound", manualMuted: false, platformMuted: false },
    contexts: [{ ref, receivedAt: 1000, context: { sourceNs: "1000", presence: "in-call", health: "recognized", reason: null,
      micMuted: true, mode: "standard", participants: [], activeParticipantIds: [], rosterComplete: false, confirmedLeave: false } }] };
}
const inspect = (input: PopupStatus, tab: number, now: number) => ({ ...describePopup(input, tab, now), rows: popupDiagnostics(input, tab, now) });
const row = (view: ReturnType<typeof inspect>, label: string) => view.rows.find(entry => entry[0] === label)?.[1];
test("unbound recording distinguishes Meet mute from captured mic and asks for explicit Link", () => {
  const view = inspect(fixture(), 7, 1100);
  assert.equal(view.title, "Recording in Gristmill");
  assert.equal(row(view, "Meet microphone"), "Muted");
  assert.equal(row(view, "Recorded microphone"), "Recording");
  assert.match(view.notice, /Link this call in your recording Note/);
  assert.equal(view.canMute, false);
});
test("unknown UI and stale context never claim recognition or show a usable manual control", () => {
  const input = fixture(); input.contexts[0].context.health = "unrecognized"; input.contexts[0].context.micMuted = null;
  const unknown = inspect(input, 7, 1100);
  assert.equal(row(unknown, "This Meet tab"), "Controls not recognized");
  assert.equal(row(unknown, "Meet microphone"), "Unknown");
  assert.match(unknown.notice, /Recording continues independently/);
  assert.equal(row(inspect(input, 7, 6100), "This Meet tab"), "Context is stale");
  assert.equal(row(inspect(input, 8, 1100), "This Meet tab"), "No context received");
});
test("linked microphone reasons and current-tab ownership stay distinct", () => {
  const input = fixture();
  if (input.snapshot?.type !== "snapshot") throw new Error("Missing fixture snapshot");
  input.snapshot.binding = input.contexts[0].ref; input.snapshot.contextState = "recognized";
  input.snapshot.manualMuted = true; input.snapshot.platformMuted = true;
  const linked = inspect(input, 7, 1100);
  assert.equal(linked.title, "Recording this call"); assert.equal(linked.canMute, true);
  assert.equal(row(linked, "Recorded microphone"), "Muted manually and by platform");
  assert.equal(inspect(input, 8, 1100).canMute, false);
  input.canControlMic = false; assert.equal(inspect(input, 7, 1100).canMute, false);
  input.snapshot.recordingState = "paused";
  assert.equal(row(inspect(input, 7, 1100), "Recorded microphone"), "Not recording");
});
test("disconnected browser observations cannot become desktop authority", () => {
  const input = fixture(); input.connected = false;
  const view = inspect(input, 7, 1100);
  assert.equal(view.title, "Open Gristmill to connect"); assert.equal(row(view, "Recording"), "Unknown");
  assert.equal(row(view, "This Meet tab"), "In call · abc-defg-hij"); assert.equal(view.canMute, false);
  assert.equal(popupStatusSchema.safeParse(input).success, true);
  assert.equal(popupStatusSchema.safeParse({ ...input, audio: "private" }).success, false);
});
