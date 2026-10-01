import type { CompanionContext } from "../../src/contracts/companion.js";

// Versioned technical controls observed in production Meet. No translated labels
// authorize capture actions. Unknown controls keep mute unknown and never imply Leave.
const LEAVE_CONTROL = 'button[jsname="CQylAd"], [role="button"][jsname="CQylAd"]';
const MIC_CONTROL = 'button[jsname="hw0c9"][data-is-muted], [role="button"][jsname="hw0c9"][data-is-muted]';
const EXIT_HEADING = 'h1[jsname="r4nke"]';
const REJOIN_CONTROL = 'button[jsname="W6suGc"]';
export const isMeetLeaveControl = (element: Element | null): boolean =>
  !!element?.closest(LEAVE_CONTROL);
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
    const leave = documents.some((doc) => doc.querySelector(LEAVE_CONTROL) !== null);
    const left = documents.some((doc) =>
      doc.querySelector(EXIT_HEADING) !== null && doc.querySelector(REJOIN_CONTROL) !== null
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
    const mic = documents.flatMap((doc) => [...doc.querySelectorAll(MIC_CONTROL)]);
    const states = new Set(mic.map((button) => button.getAttribute("data-is-muted")));
    result.health = "recognized";
    result.reason = null;
    result.presence = "in-call";
    result.mode = mic.length
      ? "standard"
      : "unknown";
    result.micMuted = states.size === 1 && states.has("true") ? true : states.size === 1 && states.has("false") ? false : null;
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
        // Explicit speaking attribute only; animated CSS/layout is not evidence.
        const speaking = tile.getAttribute("data-is-speaking") === "true";
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
