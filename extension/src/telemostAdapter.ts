import type { CompanionContext } from "../../src/contracts/companion.js";
import { callIdentity } from "./callIdentity.js";

/** Only observed technical markup belongs here. The shell's call-widget-end
 * already exists before joining and is NOT evidence that a call is connected. */
export function telemostDocuments(root: Document): Document[] {
  const documents = [root];
  const room = callIdentity(root.URL);

  if (room?.platform !== "telemost") return documents;

  for (const frame of root.querySelectorAll<HTMLIFrameElement>("iframe[allowfullscreen]")) {
    try {
      const identity = callIdentity(frame.src);

      if (identity?.platform !== "telemost" || identity.callId !== room.callId) continue;
      const doc = frame.contentDocument;

      if (doc && callIdentity(doc.URL)?.callId === room.callId) documents.push(doc);
    } catch {
      /* Inaccessible frames supply no evidence. */
    }
  }

  return documents;
}

const END = 'button[data-testid="end-call-alt-button"]';

const MIC = 'button[data-testid="turn-on-mic-button"], button[data-testid="turn-off-mic-button"]';

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();

  if (!rect.width || !rect.height) return false;

  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);

    if (
      !style ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    )
      return false;
  }

  return true;
}

function toolbar(doc: Document): Element | null {
  const ends = [...doc.querySelectorAll(END)].filter(visible);

  if (ends.length !== 1) return null;

  for (
    let node = ends[0].parentElement, depth = 0;
    node && depth < 5;
    node = node.parentElement, depth++
  ) {
    if (
      node.querySelector('button[data-testid="share-button"]') &&
      node.querySelector(
        'button[data-testid="turn-on-camera-button"], button[data-testid="turn-off-camera-button"]'
      )
    )
      return node;
  }

  return null;
}

/** Participant Leave or organizer confirmation; never End for all. */
export function isTelemostLeaveControl(element: Element): boolean {
  return (
    !!element.closest(`${END}, button[data-testid="end-call-button"]`) &&
    !!toolbar(element.ownerDocument)
  );
}

// These are observation-node identities, never service/account/voice IDs. A
// replaced node or renamed tile starts a new identity. No name/avatar merging.
const tileIds = new WeakMap<Element, { name: string; id: string }>();

let nextTileId = 0;

function readTiles(doc: Document): Pick<CompanionContext, "participants" | "activeParticipantIds"> {
  const tiles = [...doc.querySelectorAll('[data-video-root="true"] video')]
    .map((video) => ({ video, tile: video.parentElement }))
    .filter(
      (item): item is { video: HTMLVideoElement; tile: HTMLElement } =>
        !!item.tile && visible(item.tile)
    );

  const participants: CompanionContext["participants"] = [];
  const activeParticipantIds: string[] = [];
  const tracks = new Map<string, CompanionContext["participants"][number]>();

  for (const { video, tile } of tiles) {
    const names = [...tile.querySelectorAll("span[title]")].filter(
      (e) =>
        !e.closest('button, [role="menu"]') && e.getAttribute("title") === e.textContent?.trim()
    );

    if (names.length !== 1) continue;
    const name = names[0].textContent!.trim();

    if (!name || name.length > 200) continue;
    let identity = tileIds.get(video);

    if (!identity || identity.name !== name) {
      identity = { name, id: `telemost-tile-${++nextTileId}` };
      tileIds.set(video, identity);
    }

    const transform = doc.defaultView?.getComputedStyle(video).transform ?? "";
    const local = /^matrix(?:3d)?\(\s*-1(?:\.0+)?\s*,/.test(transform);
    const self = local ? "local" : "unknown";
    // Speaker view renders the same track in the main tile and thumbnail.
    // Only merge matching nonempty tracks within this snapshot, never names alone.
    const track = video.getAttribute("data-g_track_id")?.trim();
    const key = track ? JSON.stringify([track, name, self]) : null;
    const existing = key ? tracks.get(key) : undefined;
    const participant = existing ?? { id: identity.id, name, self };

    if (!existing) {
      participants.push(participant);

      if (key) tracks.set(key, participant);
    }

    // Observed speaking outline is a green ::after border on the video overlay.
    // Muted tiles cannot supply activity; no generated CSS class is required.
    const speaking =
      !tile.querySelector('[data-testid="micro-off-icon"]') &&
      [...tile.children].some((overlay) => {
        if (overlay === video || !visible(overlay)) return false;
        const style = doc.defaultView?.getComputedStyle(overlay, "::after");

        return (
          style?.content === '""' &&
          style.borderTopStyle === "solid" &&
          parseFloat(style.borderTopWidth) >= 2 &&
          style.borderTopColor === "rgb(29, 204, 102)"
        );
      });

    if (speaking && !local && !activeParticipantIds.includes(participant.id))
      activeParticipantIds.push(participant.id);
  }

  // Speaker view duplicates a person. Equal names can also be different people:
  // retain both observations, suppress all activity rather than merge identities.
  const duplicate = participants.some((p, i) =>
    participants.some((q, j) => i !== j && q.name === p.name)
  );

  return { participants, activeParticipantIds: duplicate ? [] : activeParticipantIds };
}

export function readTelemostContext(
  documents: Document[],
  sourceNs: string,
  leaveRequested = false
): CompanionContext {
  const result: CompanionContext = {
    sourceNs,
    presence: "unknown",
    health: "unrecognized",
    reason: "telemost-ui-unrecognized",
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

    if (documents.some((doc) => doc.querySelector('button[data-testid="enter-conference-button"]')))
      return { ...result, presence: "not-in-call", health: "recognized", reason: null };
    const bars = documents.map(toolbar).filter((bar): bar is Element => !!bar);

    if (
      !bars.length &&
      documents.some((doc) => doc.querySelector("#home-hub-page-title")) &&
      !documents.some((doc) =>
        doc.querySelector('[data-test-tag="call-widget"], iframe[allowfullscreen]')
      )
    )
      return {
        ...result,
        presence: "not-in-call",
        health: "recognized",
        reason: null,
        confirmedLeave: leaveRequested,
      };

    if (bars.length !== 1) return result;
    const bar = bars[0];
    const mics = [...bar.querySelectorAll(MIC)].filter(visible);

    const micMuted =
      mics.length === 1 ? mics[0].getAttribute("data-testid") === "turn-on-mic-button" : null;

    const tiles = readTiles(bar.ownerDocument);

    if (tiles.participants.length > 100) return { ...result, reason: "participant-limit" };

    return {
      ...result,
      ...tiles,
      presence: "in-call",
      health: "recognized",
      reason: null,
      micMuted,
      mode: "standard",
    };
  } catch {
    return { ...result, health: "unreadable", reason: "dom-unreadable" };
  }
}
