import type { ChromeApi } from "./chrome.js";
import { describePopup, popupStatusSchema } from "./popupState.js";
declare const chrome: ChromeApi;
const status = document.querySelector<HTMLElement>("#status")!;
const rows = document.querySelector<HTMLElement>("#rows")!;
const notice = document.querySelector<HTMLElement>("#notice")!;
const mute = document.querySelector<HTMLButtonElement>("#mute")!;
const error = document.querySelector<HTMLElement>("#error")!;
let current: ReturnType<typeof describePopup> | null = null;
let busy = false;
mute.addEventListener("click", () => {
  const value = current;
  if (!value?.recordingId || !value.canMute || busy) return;
  busy = true; mute.disabled = true; error.textContent = "";
  void chrome.runtime.sendMessage({ type: "manual-mute", recordingId: value.recordingId, muted: !value.manualMuted })
    .then((reply) => { if (!(reply as { accepted?: boolean })?.accepted) error.textContent = "Recording changed. Try again in Gristmill."; })
    .catch(() => { error.textContent = "Could not change the microphone. Try again in Gristmill."; })
    .finally(() => { busy = false; void refresh(); });
});
function render(view: ReturnType<typeof describePopup>) {
  current = view;
  status.textContent = view.title; status.dataset.tone = view.tone;
  rows.replaceChildren(...view.rows.flatMap(([label, value]) => {
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = value;
    return [term, detail];
  }));
  notice.textContent = view.notice;
  mute.hidden = !view.canMute; mute.disabled = busy;
  mute.textContent = view.manualMuted ? "Remove manual mute" : "Mute recorded microphone";
  mute.setAttribute("aria-pressed", String(view.manualMuted));
}
async function refresh() {
  try {
    const [reply, tabs] = await Promise.all([chrome.runtime.sendMessage({ type: "status" }), chrome.tabs.query({ active: true, currentWindow: true })]);
    render(describePopup(popupStatusSchema.parse(reply), tabs[0]?.id, Date.now()));
  } catch {
    render(describePopup({ connected: false, snapshot: null, error: "unavailable", contexts: [], canControlMic: false }, undefined, Date.now()));
  }
}
void refresh();
const timer = setInterval(() => void refresh(), 1000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
