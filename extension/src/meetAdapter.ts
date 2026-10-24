import type { CompanionContext } from "../../src/contracts/companion.js";

const BUTTON = 'button, [role="button"]';

const ICON = "i.google-symbols, i.google-material-icons";

const TILE = "[data-participant-id]";

// The exit screen has no semantic rejoin attribute. These observed internal IDs
// remain a versioned positive check; missing controls alone never authorize Stop.
const EXIT_HEADING = 'h1[jsname="r4nke"]';

const REJOIN_CONTROL = 'button[jsname="W6suGc"]';

function hasIcon(element: Element, names: string[]): boolean {
  return [...element.querySelectorAll(ICON)].some((icon) =>
    names.includes(icon.textContent?.trim() ?? "")
  );
}

export const isMeetLeaveControl = (element: Element | null): boolean => {
  const button = element?.closest(BUTTON);

  return !!button && hasIcon(button, ["call_end"]);
};

function participantName(tile: Element): string {
  const ownName =
    tile.getAttribute("data-self-name") ??
    tile.closest("[data-self-name]")?.getAttribute("data-self-name");

  if (ownName?.trim()) return ownName.trim();

  const names = [...tile.querySelectorAll("span.notranslate")]
    .filter(
      (span) =>
        !span.closest('button, [role="button"], [role="menu"], [role="tooltip"], svg') &&
        !span.matches(".google-symbols, .google-material-icons")
    )
    .map((span) => span.textContent?.trim() ?? "")
    .filter((name) => name.length > 0 && name.length <= 200);

  const unique = new Set(names);

  return unique.size === 1 ? names[0] : "";
}

function isLocalTile(tile: Element): boolean {
  // Granola also identifies local tiles by the effects/reframe tools and mirrored
  // video. Avoid its English "(you)" and cached display-name guesses.
  if (
    [...tile.querySelectorAll(ICON)].some(
      (icon) =>
        ["visual_effects", "frame_person"].includes(icon.textContent?.trim() ?? "") &&
        !icon.closest('[role="menu"], [role="dialog"], [role="tooltip"]')
    )
  )
    return true;

  return [...tile.querySelectorAll("video")].some((video) => {
    const transform = video.ownerDocument.defaultView?.getComputedStyle(video).transform;

    return !!transform && /^matrix(?:3d)?\(\s*-1(?:\.0+)?\s*,/.test(transform);
  });
}

const CONTROL = 'button, [role="button"], [role="menu"], [role="tooltip"]';

/** Returns the tile whose voice indicator a class change can belong to. Changes
 * on the tile itself or inside its controls (hover, menus) are not activity. */
export function meetActivityTile(target: Node): string | null {
  if (target.nodeType !== 1) return null;
  // SAFETY: nodeType 1 is an Element.
  const element = target as Element;
  const tile = element.closest(TILE);

  if (!tile || tile === element || element.closest(CONTROL)) return null;
  const id = tile.getAttribute("data-participant-id");

  return id && id.length <= 100 ? id : null;
}

export function readMeetContext(
  documents: Document[],
  sourceNs: string,
  leaveRequested: boolean,
  speaking: ReadonlySet<string> = new Set()
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
    if (documents.every((doc) => doc.visibilityState === "hidden"))
      return { ...result, health: "unreadable", reason: "hidden-context" };

    const leave = documents.some((doc) =>
      [...doc.querySelectorAll(BUTTON)].some(isMeetLeaveControl)
    );

    const left = documents.some(
      (doc) =>
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

    const mic = documents.flatMap((doc) =>
      [...doc.querySelectorAll("[data-is-muted]")].filter(
        (button) => button.matches(BUTTON) && hasIcon(button, ["mic", "mic_off"])
      )
    );

    const states = new Set(mic.map((button) => button.getAttribute("data-is-muted")));
    result.health = "recognized";
    result.reason = null;
    result.presence = "in-call";
    result.mode = mic.length ? "standard" : "unknown";
    result.micMuted =
      states.size === 1 && states.has("true")
        ? true
        : states.size === 1 && states.has("false")
          ? false
          : null;
    const participants = new Map<string, CompanionContext["participants"][number]>();
    const active = new Set<string>();
    const conflictingNames = new Set<string>();

    for (const doc of documents)
      for (const tile of doc.querySelectorAll(TILE)) {
        const id = tile.getAttribute("data-participant-id");

        if (!id || id.length > 100) continue;
        const name = participantName(tile);

        if (name.length > 200) continue;
        const self = isLocalTile(tile) ? "local" : "unknown";
        const previous = participants.get(id);

        if (conflictingNames.has(id) || (previous && previous.name !== name)) {
          conflictingNames.add(id);
          participants.set(id, { id, name: "", self: "unknown" });
          active.delete(id);
          continue;
        }

        const local = self === "local" || previous?.self === "local";
        participants.set(id, { id, name, self: local ? "local" : "unknown" });

        // Indicator activity is a UI hint, not a voice identity. Keep every
        // active ID; the downstream matcher rejects overlap and clock gaps.
        if (local) active.delete(id);
        else if (speaking.has(id)) active.add(id);
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
