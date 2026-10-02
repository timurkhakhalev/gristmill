import type { ChromeApi } from "./chrome.js";
import { describePopup, popupDiagnostics, popupStatusSchema } from "./popupState.js";
declare const chrome: ChromeApi;
declare const COMPANION_DEV: boolean;
declare const COMPANION_VERSION: string;
const appName = COMPANION_DEV ? "Gristmill Dev" : "Gristmill";
document.querySelector<HTMLElement>("#channel")!.hidden = !COMPANION_DEV;
document.querySelector<HTMLElement>("#version")!.textContent = `v${COMPANION_VERSION}`;
const status = document.querySelector<HTMLElement>("#status")!;
const notice = document.querySelector<HTMLElement>("#notice")!;
const mute = document.querySelector<HTMLButtonElement>("#mute")!;
const error = document.querySelector<HTMLElement>("#error")!;
const connection = document.querySelector<HTMLElement>("#connection")!;
const connectionLabel = document.querySelector<HTMLElement>("#connection-label")!;
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
  status.textContent = view.connected ? view.title : `Open ${appName} to connect`;
  connection.dataset.connected = String(view.connected);
  connectionLabel.textContent = view.connected ? `Connected to ${appName}` : `${appName} is offline`;
  notice.textContent = view.notice;
  mute.hidden = !view.canMute; mute.disabled = busy;
  mute.textContent = view.manualMuted ? "Unmute my microphone" : "Mute my microphone";
  mute.setAttribute("aria-pressed", String(view.manualMuted));
}
function renderDiagnostics(rows: Array<[string, string]>) {
  document.querySelector<HTMLElement>("#rows")!.replaceChildren(...rows.flatMap(([label, value]) => {
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = value;
    return [term, detail];
  }));
}
async function refresh() {
  try {
    const [reply, tabs] = await Promise.all([chrome.runtime.sendMessage({ type: "status" }), chrome.tabs.query({ active: true, currentWindow: true })]);
    const value = popupStatusSchema.parse(reply);
    const now = Date.now();
    render(describePopup(value, tabs[0]?.id, now));
    if (COMPANION_DEV) renderDiagnostics(popupDiagnostics(value, tabs[0]?.id, now));
  } catch {
    const unavailable = { connected: false, snapshot: null, error: "unavailable", contexts: [], canControlMic: false };
    render(describePopup(unavailable, undefined, Date.now()));
    if (COMPANION_DEV) renderDiagnostics(popupDiagnostics(unavailable, undefined, Date.now()));
  }
}
void refresh();
const timer = setInterval(() => void refresh(), 1000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
