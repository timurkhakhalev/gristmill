import type { ChromeApi } from "./chrome.js";
import { describePopup, popupDiagnostics, popupStatusSchema } from "./popupState.js";

declare const chrome: ChromeApi;

declare const COMPANION_DEV: boolean;

declare const COMPANION_VERSION: string;

const appName = COMPANION_DEV ? "Gristmill Dev" : "Gristmill";

// The popup owns popup.html; every id below ships in that document.
function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) throw new Error(`Missing popup element: ${selector}`);

  return element;
}

requireElement<HTMLElement>("#channel").hidden = !COMPANION_DEV;

requireElement<HTMLElement>("#version").textContent = `v${COMPANION_VERSION}`;

const status = requireElement<HTMLElement>("#status");

const notice = requireElement<HTMLElement>("#notice");

const mute = requireElement<HTMLButtonElement>("#mute");

const error = requireElement<HTMLElement>("#error");

const connection = requireElement<HTMLElement>("#connection");

const connectionLabel = requireElement<HTMLElement>("#connection-label");

let current: ReturnType<typeof describePopup> | null = null;

let busy = false;

mute.addEventListener("click", () => {
  const value = current;

  if (!value?.recordingId || !value.canMute || busy) return;
  busy = true;
  mute.disabled = true;
  error.textContent = "";
  void chrome.runtime
    .sendMessage({ type: "manual-mute", recordingId: value.recordingId, muted: !value.manualMuted })
    .then((reply) => {
      // SAFETY: the worker answers manual-mute with an {accepted} envelope.
      if (!(reply as { accepted?: boolean })?.accepted)
        error.textContent = "Recording changed. Try again in Gristmill.";
    })
    .catch(() => {
      error.textContent = "Could not change the microphone. Try again in Gristmill.";
    })
    .finally(() => {
      busy = false;

      void refresh().catch(() => undefined);
    });
});

function render(view: ReturnType<typeof describePopup>) {
  current = view;
  status.textContent = view.connected ? view.title : `Open ${appName} to connect`;
  connection.dataset.connected = String(view.connected);
  connectionLabel.textContent = view.connected
    ? `Connected to ${appName}`
    : `${appName} is offline`;
  notice.textContent = view.notice;
  mute.hidden = !view.canMute;
  mute.disabled = busy;
  mute.textContent = view.manualMuted ? "Unmute my microphone" : "Mute my microphone";
  mute.setAttribute("aria-pressed", String(view.manualMuted));
}

function renderDiagnostics(rows: Array<[string, string]>) {
  requireElement<HTMLElement>("#rows").replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;

      return [term, detail];
    })
  );
}

async function refresh() {
  try {
    const [reply, tabs] = await Promise.all([
      chrome.runtime.sendMessage({ type: "status" }),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);

    const value = popupStatusSchema.parse(reply);
    const now = Date.now();
    render(describePopup(value, tabs[0]?.id, now));

    if (COMPANION_DEV) renderDiagnostics(popupDiagnostics(value, tabs[0]?.id, now));
  } catch {
    const unavailable = {
      connected: false,
      snapshot: null,
      error: "unavailable",
      contexts: [],
      contextErrors: [],
      canControlMic: false,
    };

    render(describePopup(unavailable, undefined, Date.now()));

    if (COMPANION_DEV) renderDiagnostics(popupDiagnostics(unavailable, undefined, Date.now()));
  }
}

void refresh().catch(() => undefined);

const timer = setInterval(() => void refresh().catch(() => undefined), 1000);

window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
