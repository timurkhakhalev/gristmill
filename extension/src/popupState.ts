import { z } from "zod";
import { companionCallRefSchema, companionContextSchema, companionDesktopMessageSchema } from "../../src/contracts/companion.js";

export const popupStatusSchema = z.object({
  connected: z.boolean(), snapshot: companionDesktopMessageSchema.nullable(), error: z.string(),
  canControlMic: z.boolean(),
  contexts: z.array(z.object({ ref: companionCallRefSchema, context: companionContextSchema, receivedAt: z.number() }).strict()).max(32),
}).strict();
export type PopupStatus = z.infer<typeof popupStatusSchema>;

/** Browser observations explain detection; only main snapshots authorize recording controls. */
function readPopupState(reply: PopupStatus, activeTabId: number | undefined, now: number) {
  const snapshot = reply.snapshot?.type === "snapshot" && reply.connected ? reply.snapshot : null;
  const observed = reply.contexts.find(value => value.ref.tabId === activeTabId);
  const fresh = observed && now - observed.receivedAt <= 5_000 && now >= observed.receivedAt;
  const context = fresh ? observed.context : null;
  const binding = snapshot?.binding;
  const thisCall = !!binding && !!observed && binding.installationId === observed.ref.installationId &&
    binding.sessionId === observed.ref.sessionId && binding.tabId === observed.ref.tabId &&
    binding.documentId === observed.ref.documentId && binding.callId === observed.ref.callId;
  const recording = snapshot?.recordingState === "recording";
  const linked = !!binding;
  return { snapshot, observed, context, binding, thisCall, recording, linked };
}

export function popupDiagnostics(reply: PopupStatus, activeTabId: number | undefined, now: number) {
  const { snapshot, observed, context, binding, thisCall, recording } = readPopupState(reply, activeTabId, now);
  const rows: Array<[string, string]> = [
    ["App connection", snapshot ? "Connected" : "Disconnected"],
    ["Recording", !snapshot ? "Unknown" : recording ? "Recording" : snapshot.recordingState === "paused" ? "Paused" : "Stopped"],
    ["This Meet tab", !observed ? "No context received" : !context ? "Context is stale" :
      context.health !== "recognized" ? context.health === "unreadable" ? "Cannot read controls" : "Controls not recognized" :
      context.presence === "in-call" ? `In call · ${observed.ref.callId}` : context.presence === "not-in-call" ? "Not in call" : "Unknown"],
    ["Recording link", !snapshot ? "Unknown" : !binding ? "Not linked" : thisCall ? "Linked to this call" : `Linked to another call · ${binding.callId}`],
    ["Meet microphone", context?.micMuted === true ? "Muted" : context?.micMuted === false ? "On" : "Unknown"],
    ["Recorded microphone", !snapshot ? "Unknown" : !recording ? "Not recording" :
      snapshot.manualMuted && snapshot.platformMuted ? "Muted manually and by platform" :
      snapshot.manualMuted ? "Muted manually" : snapshot.platformMuted ? "Muted by platform" : "Recording"],
  ];
  return rows;
}

export function describePopup(reply: PopupStatus, activeTabId: number | undefined, now: number) {
  const { snapshot, context, thisCall, recording, linked } = readPopupState(reply, activeTabId, now);
  let notice: string;
  if (!snapshot) notice = "Open the app and enable Companion in Settings → Recording.";
  else if (snapshot.contextState === "disabled") notice = "Enable Companion in Gristmill Settings → Recording.";
  else if (recording && !linked && context?.health === "recognized" && context.presence === "in-call")
    notice = "Link this call in your recording Note to follow its mute and Leave controls.";
  else if (recording && !linked) notice = "Recording continues independently. Link a call in your Note when you’re ready.";
  else if (snapshot.contextState === "unavailable") notice = "Call connection lost. Your recording continues in Gristmill.";
  else if (recording && thisCall) notice = snapshot.manualMuted || snapshot.platformMuted
    ? "Microphone muted. Call audio is still being recorded."
    : "Your microphone and call audio are being recorded.";
  else if (recording && linked) notice = "Open the linked call to use its recording controls.";
  else if (snapshot.recordingState === "paused") notice = "Resume your recording in Gristmill when you’re ready.";
  else notice = "Start a recording in Gristmill to connect your call.";
  return { title: !snapshot ? "Open Gristmill to connect" : snapshot.contextState === "disabled" ? "Companion is turned off" :
      recording ? !linked ? "Recording in Gristmill" : snapshot.contextState === "unavailable" ? "Call connection lost" : thisCall ? "Recording this call" : "Recording another call" :
      snapshot.recordingState === "paused" ? "Recording paused" : "Ready for your next call",
    connected: !!snapshot,
    tone: !snapshot || (recording && (!linked || snapshot.contextState === "unavailable")) ? "warning" : "ready",
    notice, canMute: recording && thisCall && reply.canControlMic,
    manualMuted: snapshot?.manualMuted ?? false, recordingId: snapshot?.recordingId ?? null };
}
