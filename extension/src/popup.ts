import type { ChromeApi } from "./chrome.js";
import { companionDesktopMessageSchema } from "../../src/contracts/companion.js";
declare const chrome: ChromeApi;
const status = document.querySelector<HTMLElement>("#status")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
async function refresh() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "status" }) as { snapshot?: unknown };
    const parsed = companionDesktopMessageSchema.safeParse(reply?.snapshot);
    if (!parsed.success || parsed.data.type !== "snapshot") {
      status.textContent = "Gristmill is not connected";
      detail.textContent = "Open Gristmill and install its Google Meet integration in Settings.";
      return;
    }
    const value = parsed.data;
    status.textContent = value.recordingState === "recording" ? "Recording" : value.recordingState === "paused" ? "Recording paused" : "Connected to Gristmill";
    detail.textContent = value.binding ? `Google Meet · ${value.binding.callId}${value.manualMuted || value.platformMuted ? " · Microphone muted" : ""}` : "No call is linked to a recording.";
  } catch {
    status.textContent = "Gristmill is not connected";
    detail.textContent = "Open Gristmill to reconnect.";
  }
}
void refresh();
const timer = setInterval(() => void refresh(), 1000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
