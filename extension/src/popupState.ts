import { z } from "zod";
import { companionCallRefSchema, companionContextSchema, companionDesktopMessageSchema } from "../../src/contracts/companion.js";

export const popupStatusSchema = z.object({
  connected: z.boolean(), snapshot: companionDesktopMessageSchema.nullable(), error: z.string(),
  canControlMic: z.boolean(),
  contexts: z.array(z.object({ ref: companionCallRefSchema, context: companionContextSchema, receivedAt: z.number() }).strict()).max(32),
}).strict();
export type PopupStatus = z.infer<typeof popupStatusSchema>;

/** Browser observations explain detection; only main snapshots authorize recording controls. */
export function describePopup(reply: PopupStatus, activeTabId: number | undefined, now: number) {
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
  let notice: string;
  if (!snapshot) notice = "Open Gristmill and enable Google Meet integration in Settings → Recording for the app you want to use.";
  else if (snapshot.contextState === "disabled") notice = "Meet integration is disabled in Gristmill Settings.";
  else if (recording && !linked && context?.health === "recognized" && context.presence === "in-call")
    notice = "Choose Link in the recording Note. Until then, Meet mute and Leave do not control this recording.";
  else if (recording && !linked) notice = "Recording continues independently. Meet mute and Leave do not control it. Keep the Meet tab visible; if controls stay unrecognized, report this state.";
  else if (snapshot.contextState === "unavailable") notice = "Meet context was lost. Recording continues and the last microphone gate is kept.";
  else if (recording && thisCall) notice = "Meet mute controls the recorded microphone. System audio continues. Confirmed Leave ends recording and offers Restart.";
  else if (recording && linked) notice = "This tab does not control the recording. Its linked call is shown above.";
  else notice = "Join a Meet call, then start recording in Gristmill.";
  return { title: recording ? linked ? "Recording · linked" : "Recording · not linked" : snapshot ? snapshot.recordingState === "paused" ? "Recording paused" : "Ready" : "App disconnected",
    tone: !snapshot || (recording && (!linked || snapshot.contextState === "unavailable")) ? "warning" : "ready",
    rows, notice, canMute: recording && thisCall && reply.canControlMic,
    manualMuted: snapshot?.manualMuted ?? false, recordingId: snapshot?.recordingId ?? null };
}
