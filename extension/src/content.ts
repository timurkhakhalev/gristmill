import { companionDesktopMessageSchema } from "../../src/contracts/companion.js";
import { isMeetLeaveControl, readMeetContext } from "./meetAdapter.js";
import type { ChromeApi } from "./chrome.js";
declare const chrome: ChromeApi;
interface PiPWindow extends Window {
  documentPictureInPicture?: EventTarget & { window?: Window | null };
}
const sourceNs = () => String(BigInt(Math.round(performance.now() * 1e6)));
let stopped = false;
let scheduled = false;
let leaveRequestedUntil = 0;
let lastProbe = -Infinity;
const observed = new Map<Document, MutationObserver>();
const onClick = (event: Event) => {
  if (event.isTrusted && event.target instanceof Element && isMeetLeaveControl(event.target))
    leaveRequestedUntil = performance.now() + 10_000;
};
function documents(): Document[] {
  const pip = (window as PiPWindow).documentPictureInPicture?.window;
  return pip && !pip.closed ? [document, pip.document] : [document];
}
function scan(): void {
  scheduled = false;
  if (stopped) return;
  const docs = documents();
  for (const [doc, observer] of observed)
    if (!docs.includes(doc)) {
      observer.disconnect();
      doc.removeEventListener("click", onClick, true);
      observed.delete(doc);
    }
  for (const doc of docs)
    if (!observed.has(doc)) {
      const observer = new MutationObserver(schedule);
      observer.observe(doc.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      doc.addEventListener("click", onClick, true);
      observed.set(doc, observer);
    }
  const context = readMeetContext(
    docs,
    sourceNs(),
    performance.now() <= leaveRequestedUntil && leaveRequestedUntil > 0
  );
  void chrome.runtime.sendMessage({ type: "context", context }).catch(() => {});
  if (performance.now() - lastProbe >= 1000) {
    lastProbe = performance.now();
    void chrome.runtime
      .sendMessage({ type: "clock-probe", nonce: crypto.randomUUID(), sourceSendNs: sourceNs() })
      .catch(() => {});
  }
}
function schedule(): void {
  if (!scheduled && !stopped) {
    scheduled = true;
    setTimeout(scan, 100);
  }
}
chrome.runtime.onMessage.addListener((value) => {
  const received = sourceNs();
  const parsed = companionDesktopMessageSchema.safeParse(value);
  if (parsed.success && parsed.data.type === "clock-reply") {
    void chrome.runtime
      .sendMessage({ type: "clock-confirm", nonce: parsed.data.nonce, sourceReceiveNs: received })
      .catch(() => {});
  }
});
let timer = setInterval(scan, 1000);
document.addEventListener("visibilitychange", schedule);
window.addEventListener("pageshow", (event) => {
  if (event.persisted && stopped) { stopped = false; timer = setInterval(scan, 1000); scan(); }
});
window.addEventListener(
  "pagehide",
  () => {
    stopped = true;
    clearInterval(timer);
    for (const [doc, observer] of observed) {
      observer.disconnect();
      doc.removeEventListener("click", onClick, true);
    }
    observed.clear();
  },
  { once: true }
);
(window as PiPWindow).documentPictureInPicture?.addEventListener("enter", schedule);
scan();
