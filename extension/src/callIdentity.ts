import type { CompanionCallRef } from "../../src/contracts/companion.js";

/** Room identity comes from Chrome's document URL, never from page messages. */
export function callIdentity(value: string): Pick<CompanionCallRef, "platform" | "callId"> | null {
  try {
    const url = new URL(value);
    if (url.origin === "https://meet.google.com") {
      const match = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/.exec(url.pathname);
      return match ? { platform: "google-meet", callId: match[1] } : null;
    }
    if (url.origin === "https://telemost.yandex.ru") {
      const match = /^\/(?:j|@\/j|private-join)\/(\d{14})\/?$/.exec(url.pathname);
      return match ? { platform: "telemost", callId: match[1] } : null;
    }
  } catch { /* Unknown URLs have no recording authority. */ }
  return null;
}
