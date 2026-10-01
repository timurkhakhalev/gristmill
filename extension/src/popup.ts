import type { ChromeApi } from "./chrome.js";
import { companionDesktopMessageSchema } from "../../src/contracts/companion.js";
declare const chrome: ChromeApi;
const status = document.querySelector<HTMLElement>("#status")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
const health = document.querySelector<HTMLElement>("#health")!;
const mute = document.querySelector<HTMLButtonElement>("#mute")!;
const error = document.querySelector<HTMLElement>("#error")!;
let current: Extract<import("../../src/contracts/companion.js").CompanionDesktopMessage, { type: "snapshot" }> | null = null;
let busy = false;
mute.addEventListener("click", () => {
  const value = current;
  if (!value?.recordingId || busy) return;
  busy = true; mute.disabled = true; error.textContent = "";
  void chrome.runtime.sendMessage({ type: "manual-mute", recordingId: value.recordingId, muted: !value.manualMuted })
    .then((reply) => { if (!(reply as { accepted?: boolean })?.accepted) error.textContent = "Recording changed. Try again in Gristmill."; })
    .catch(() => { error.textContent = "Could not change the microphone. Try again in Gristmill."; })
    .finally(() => { busy = false; void refresh(); });
});
async function refresh() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "status" }) as { snapshot?: unknown };
    const parsed = companionDesktopMessageSchema.safeParse(reply?.snapshot);
    if (!parsed.success || parsed.data.type !== "snapshot") {
      current = null; mute.hidden = true; health.textContent = "";
      status.textContent = "Gristmill is not connected";
      detail.textContent = "Open Gristmill and install its Google Meet integration in Settings.";
      return;
    }
    const value = parsed.data;
    current = value;
    mute.hidden = value.recordingState !== "recording" || !value.binding || value.contextState === "disabled";
    mute.disabled = busy;
    mute.textContent = value.manualMuted ? "Unmute microphone" : "Mute microphone";
    mute.setAttribute("aria-pressed", String(value.manualMuted));
    health.textContent = value.contextState === "unavailable" ? "Meet context unavailable. Recording continues; check the microphone in Gristmill."
      : value.contextState === "disabled" ? "Meet integration disabled."
      : value.contextState === "recognized" ? "Meet context is current." : "Link a call in the recording Note.";
    status.textContent = value.recordingState === "recording" ? "Recording" : value.recordingState === "paused" ? "Recording paused" : "Connected to Gristmill";
    detail.textContent = value.binding ? `Google Meet · ${value.binding.callId}${value.manualMuted || value.platformMuted ? " · Microphone muted" : ""}` : "No call is linked to a recording.";
  } catch {
    current = null; mute.hidden = true; health.textContent = "";
    status.textContent = "Gristmill is not connected";
    detail.textContent = "Open Gristmill to reconnect.";
  }
}
void refresh();
const timer = setInterval(() => void refresh(), 1000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
