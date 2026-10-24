/** Google Meet animates the voice indicator of a heard participant by swapping
 * generated class tokens several times per second. The tokens change between
 * Meet builds, so only the rate of class changes inside a tile is a signal.
 * Live 2026-10-10 call: 5–23 changes/s while a remote participant spoke, at
 * most about one per second when silent and none while muted. */
export const MEET_ACTIVITY_WINDOW_MS = 1000;

export const MEET_ACTIVITY_MIN_CHANGES = 4;

export const MEET_ACTIVITY_HOLD_MS = 1000;

const MAX_TILES = 100;

export class MeetSpeakingActivity {
  private readonly changes = new Map<string, number[]>();
  private readonly activeUntil = new Map<string, number>();

  note(id: string, at: number): void {
    if (!this.changes.has(id) && this.changes.size >= MAX_TILES) return;

    const recent = (this.changes.get(id) ?? []).filter(
      (time) => time > at - MEET_ACTIVITY_WINDOW_MS && time <= at
    );

    recent.push(at);
    this.changes.set(id, recent);

    if (recent.length >= MEET_ACTIVITY_MIN_CHANGES)
      this.activeUntil.set(id, at + MEET_ACTIVITY_HOLD_MS);
  }

  active(at: number): Set<string> {
    const result = new Set<string>();

    for (const [id, until] of this.activeUntil)
      if (until > at) result.add(id);
      else this.activeUntil.delete(id);

    for (const [id, times] of this.changes)
      if (!times.some((time) => time > at - MEET_ACTIVITY_WINDOW_MS)) this.changes.delete(id);

    return result;
  }
}
