import { randomUUID } from "node:crypto";
import type { CompanionBinding, CompanionContext } from "../contracts/companion.js";
import type { MeetingPlatformObservation } from "../contracts/meetingRecording.js";
import type { MeetingClockMapping } from "./meetingClockSync.js";

/** Only adjacent, calibrated confirmations cover time; one snapshot covers none. */
export class MeetSpeakerEvidence {
  private previous: {
    binding: CompanionBinding;
    context: CompanionContext;
    mapping: MeetingClockMapping;
  } | null = null;
  private episodes = new Map<string, { id: string; name: string; revision: number }>();
  constructor(private readonly save: (observation: MeetingPlatformObservation) => void) {}
  reset(): void {
    this.previous = null;
    this.episodes.clear();
  }
  observe(
    binding: CompanionBinding,
    context: CompanionContext,
    mapping: MeetingClockMapping | null
  ): void {
    if (
      !mapping ||
      mapping.uncertaintyNs > 25_000_000 ||
      context.health !== "recognized" ||
      context.presence !== "in-call"
    ) {
      this.reset();
      return;
    }
    const previous = this.previous;
    this.previous = { binding, context, mapping };
    const delta = previous ? BigInt(context.sourceNs) - BigInt(previous.context.sourceNs) : 0n;
    if (
      !previous ||
      previous.binding.id !== binding.id ||
      previous.binding.generation !== binding.generation ||
      previous.mapping.generation !== mapping.generation ||
      delta <= 0n ||
      delta > 2_000_000_000n
    ) {
      this.episodes.clear();
      return;
    }
    const start = previous.mapping.helperMaximumNs;
    const end = mapping.helperMinimumNs;
    if (BigInt(end) <= BigInt(start)) return;
    const active = context.activeParticipantIds;
    const previousActive = previous.context.activeParticipantIds;
    const continued =
      active.length === 1 && previousActive.length === 1 && active[0] === previousActive[0];
    const currentIds = new Set(context.participants.map((person) => person.id));
    for (const id of this.episodes.keys())
      if (!currentIds.has(id) || !active.includes(id)) this.episodes.delete(id);
    for (const participant of context.participants) {
      const prior = previous.context.participants.find((person) => person.id === participant.id);
      let episode = this.episodes.get(participant.id);
      if (!episode || episode.name !== participant.name) {
        episode = {
          id: randomUUID(),
          name: participant.name,
          revision: (episode?.revision ?? 0) + 1,
        };
        this.episodes.set(participant.id, episode);
      }
      const explicit =
        continued &&
        active[0] === participant.id &&
        prior?.name === participant.name &&
        participant.name.length > 0;
      this.save({
        id: randomUUID(),
        platform: "google-meet",
        bindingId: binding.id,
        recordingId: binding.recordingId,
        sessionId: binding.ref.sessionId,
        instanceKey: participant.id,
        episodeId: episode.id,
        nameRevision: episode.revision,
        displayName: participant.name,
        self: participant.self,
        activeParticipantIds: active,
        clockGeneration: mapping.generation,
        clockUncertaintyNs: String(Math.max(mapping.uncertaintyNs, previous.mapping.uncertaintyNs)),
        readStartHostNs: start,
        readEndHostNs: end,
        windowMode: "unknown",
        singleSpeaker: null,
        provenance: "system-wide",
        activity: explicit ? "explicit" : active.length > 1 ? "ambiguous" : "candidate",
        reason: explicit ? null : "activity-unconfirmed",
      });
    }
  }
}
