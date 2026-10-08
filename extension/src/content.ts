import { companionDesktopMessageSchema } from "../../src/contracts/companion.js";
import { isMeetLeaveControl, readMeetContext } from "./meetAdapter.js";
import {
  isTelemostLeaveControl,
  readTelemostContext,
  telemostDocuments,
} from "./telemostAdapter.js";
import { callIdentity } from "./callIdentity.js";
import type { CompanionContext } from "../../src/contracts/companion.js";
import type { ChromeApi } from "./chrome.js";

type CompanionContentMessage =
  | { type: "context"; context: CompanionContext }
  | { type: "clock-probe"; nonce: string; sourceSendNs: string }
  | { type: "clock-confirm"; nonce: string; sourceReceiveNs: string };

declare const chrome: ChromeApi;

interface PiPWindow extends Window {
  documentPictureInPicture?: EventTarget & { window?: Window | null };
}

const telemost = document.location?.hostname === "telemost.yandex.ru";

const sourceNs = () => String(BigInt(Math.round(performance.now() * 1e6)));

let stopped = false;

let scheduled = false;

let leaveRequestedUntil = 0;

let leaveRoom: string | null = null;

let leaveMenuRequested = false;

let lastProbe = -Infinity;

const observed = new Map<Document, MutationObserver>();

function stop(): void {
  stopped = true;
  clearInterval(timer);

  for (const [doc, observer] of observed) {
    observer.disconnect();
    doc.removeEventListener("click", onClick, true);
  }

  observed.clear();
}

// Outgoing context/probe envelopes are built here from scanned DOM state;
// the worker schema-parses each on arrival.
function send(value: CompanionContentMessage): void {
  if (stopped) return;

  try {
    void chrome.runtime.sendMessage(value).catch(() => {});
  } catch {
    // Reloading the extension invalidates the old content script synchronously.
    stop();
  }
}

const onClick = (event: Event) => {
  // SAFETY: click targets on scanned documents are Elements; other node types
  // are rejected by the nodeType check below.
  const element = event.target as Element | null;

  // The Telemost control belongs to another Window; instanceof Element would
  // reject a genuine click from that same-origin iframe.
  if (!event.isTrusted || element?.nodeType !== 1) return;

  if (telemost) {
    const room = callIdentity(document.URL);

    if (
      room?.platform === "telemost" &&
      documents().includes(element.ownerDocument) &&
      isTelemostLeaveControl(element)
    ) {
      leaveRoom = room.callId;
      leaveMenuRequested = !!element.closest('button[data-testid="end-call-alt-button"]');
      leaveRequestedUntil = performance.now() + 10_000;
    }
  } else if (isMeetLeaveControl(element)) leaveRequestedUntil = performance.now() + 10_000;
};

function documents(): Document[] {
  if (telemost) return telemostDocuments(document);
  // SAFETY: only the documentPictureInPicture capability of this window is read.
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

  const room = callIdentity(document.URL);

  if (telemost && room && room.callId !== leaveRoom) {
    leaveRoom = null;
    leaveRequestedUntil = 0;
  }

  if (
    telemost &&
    leaveMenuRequested &&
    docs.some((doc) => doc.querySelector('button[data-testid="end-call-button"]'))
  ) {
    leaveRoom = null;
    leaveRequestedUntil = 0;
    leaveMenuRequested = false;
  }

  const context = telemost
    ? readTelemostContext(
        docs,
        sourceNs(),
        leaveRoom !== null && performance.now() <= leaveRequestedUntil
      )
    : readMeetContext(
        docs,
        sourceNs(),
        performance.now() <= leaveRequestedUntil && leaveRequestedUntil > 0
      );

  send({ type: "context", context });

  if (performance.now() - lastProbe >= 1000) {
    lastProbe = performance.now();
    send({ type: "clock-probe", nonce: crypto.randomUUID(), sourceSendNs: sourceNs() });
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
    send({ type: "clock-confirm", nonce: parsed.data.nonce, sourceReceiveNs: received });
  }
});

let timer = setInterval(scan, 1000);

document.addEventListener("visibilitychange", schedule);

window.addEventListener("pageshow", (event) => {
  if (event.persisted && stopped) {
    stopped = false;
    timer = setInterval(scan, 1000);
    scan();
  }
});

window.addEventListener("pagehide", stop);

// SAFETY: only the documentPictureInPicture capability of this window is read.
(window as PiPWindow).documentPictureInPicture?.addEventListener("enter", schedule);

scan();
