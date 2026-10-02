import { randomUUID } from "node:crypto";
import type {
  MeetingAudioClockMessage,
  MeetingAudioClockAnchor,
} from "../contracts/meetingRecording.js";

/** Native audio anchors stay available even when optional UI evidence fails. */
export class MeetingAudioClockCollector {
  private bindings = new Map<
    string,
    { epochIndex: number; epochStartFrame: number; deliveredFrames: number }
  >();
  private pending: MeetingAudioClockMessage[] = [];
  private writes: MeetingAudioClockAnchor[] = [];
  private drainHandle: NodeJS.Immediate | null = null;
  private failure: string | null = null;
  constructor(
    private readonly recordingId: string,
    private readonly save: (anchor: MeetingAudioClockAnchor) => void
  ) {}
  bindClock(generation: string, epochIndex: number, epochStartFrame: number): void {
    this.bindings.set(generation, { epochIndex, epochStartFrame, deliveredFrames: 0 });
    this.flush();
  }
  recordDeliveredFrames(generation: string | undefined, frames: number): void {
    const binding = generation ? this.bindings.get(generation) : undefined;
    if (binding) {
      binding.deliveredFrames += frames;
      this.flush();
    }
  }
  recordClock(clock: MeetingAudioClockMessage): void {
    if (this.failure) return;
    if (this.pending.length + this.writes.length >= 128) {
      this.failure = "clock-queue-overflow";
      this.pending = [];
      this.writes = [];
      return;
    }
    this.pending.push(clock);
    this.flush();
  }
  private flush(): void {
    this.pending = this.pending.filter((clock) => {
      const binding = this.bindings.get(clock.generation);
      if (!binding || clock.endFrame > binding.deliveredFrames) return true;
      this.writes.push({
        id: randomUUID(),
        recordingId: this.recordingId,
        epochIndex: binding.epochIndex,
        epochStartFrame: binding.epochStartFrame,
        clock,
      });
      return false;
    });
    if (this.writes.length) this.drainHandle ??= setImmediate(() => this.drain());
  }
  private drain(): void {
    this.drainHandle = null;
    try {
      for (const anchor of this.writes) this.save(anchor);
    } catch {
      this.failure = "metadata-write-failed";
    }
    this.writes = [];
  }
  stop(): string | null {
    this.flush();
    if (this.drainHandle) clearImmediate(this.drainHandle);
    this.drain();
    const error = this.failure ?? (this.pending.length ? "metadata-tail-incomplete" : null);
    this.pending = [];
    this.bindings.clear();
    return error;
  }
}
