import type { CompanionContext } from "../../src/contracts/companion.js";

// Adapter v1. Only positive controls/participant IDs are evidence. Layout and
// missing selectors never imply Leave, unmute, or a single active speaker.
const LEAVE = /^(leave call|leave meeting|покинуть звонок|покинуть встречу|выйти из звонка)/i;
const MUTE = /^(turn off microphone|выключить микрофон|отключить микрофон)/i;
const UNMUTE = /^(turn on microphone|включить микрофон)/i;
const LEFT = /^(you left the meeting|вы покинули встречу|вы вышли из встречи)[.!]?$/i;
export const isMeetLeaveControl = (element: Element | null): boolean => {
  const button = element?.closest('button, [role="button"]');
  return !!button && LEAVE.test(button.getAttribute("aria-label") ?? "");
};
export function readMeetContext(
  documents: Document[],
  sourceNs: string,
  leaveRequested: boolean
): CompanionContext {
  const result: CompanionContext = {
    sourceNs,
    presence: "unknown",
    health: "unrecognized",
    reason: "meet-ui-unrecognized",
    micMuted: null,
    mode: "unknown",
    participants: [],
    activeParticipantIds: [],
    rosterComplete: false,
    confirmedLeave: false,
  };
  try {
    if (documents.every((doc) => doc.visibilityState === "hidden")) return { ...result, health: "unreadable", reason: "hidden-context" };
    const controls = documents.flatMap((doc) => [
      ...doc.querySelectorAll('button[aria-label], [role="button"][aria-label]'),
    ]);
    const leave = controls.some((button) => LEAVE.test(button.getAttribute("aria-label") ?? ""));
    const left = documents.some((doc) =>
      [...doc.querySelectorAll('h1, h2, [role="heading"]')].some((node) =>
        LEFT.test(node.textContent?.trim() ?? "")
      )
    );
    if (left && !leave)
      return {
        ...result,
        health: "recognized",
        reason: null,
        presence: "not-in-call",
        confirmedLeave: leaveRequested,
      };
    if (!leave) return result;
    const mic = controls.filter(
      (button) =>
        MUTE.test(button.getAttribute("aria-label") ?? "") ||
        UNMUTE.test(button.getAttribute("aria-label") ?? "")
    );
    const states = new Set(
      mic.map((button) => UNMUTE.test(button.getAttribute("aria-label") ?? ""))
    );
    result.health = "recognized";
    result.reason = null;
    result.presence = "in-call";
    result.mode = mic.length
      ? "standard"
      : documents.some((doc) => /Companion mode|Режим компаньона/i.test(doc.body.innerText))
        ? "companion"
        : "unknown";
    result.micMuted = states.size === 1 ? [...states][0] : null;
    const participants = new Map<string, CompanionContext["participants"][number]>();
    const active = new Set<string>();
    for (const doc of documents)
      for (const tile of doc.querySelectorAll("[data-participant-id]")) {
        const id = tile.getAttribute("data-participant-id");
        if (!id || id.length > 100) continue;
        const name =
          tile.querySelector("[data-self-name], [data-participant-name]")?.textContent?.trim() ??
          tile.getAttribute("data-participant-name") ??
          "";
        if (name.length > 200) continue;
        const self = tile.getAttribute("data-is-self") === "true" ? "local" : "unknown";
        const previous = participants.get(id);
        if (previous && previous.name !== name) {
          participants.set(id, { id, name: "", self: "unknown" });
          continue;
        }
        participants.set(id, { id, name, self });
        // Explicit accessible speaking state only; animated CSS/layout is not evidence.
        const speaking =
          tile.getAttribute("data-is-speaking") === "true" ||
          [...tile.querySelectorAll("[aria-label]")].some((node) =>
            /^(speaking|говорит)$/i.test(node.getAttribute("aria-label") ?? "")
          );
        if (speaking) active.add(id);
      }
    if (participants.size > 100)
      return { ...result, health: "unrecognized", reason: "participant-limit", micMuted: null };
    result.participants = [...participants.values()];
    result.activeParticipantIds = [...active];
    return result;
  } catch {
    return {
      ...result,
      health: "unreadable",
      reason: "dom-unreadable",
      micMuted: null,
      confirmedLeave: false,
    };
  }
}
