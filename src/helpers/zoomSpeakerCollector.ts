import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "string_decoder";
import { MeetingAudioClockCollector } from "./meetingAudioClockCollector.js";
import { resolveBundledBinary } from "./binaryResolver.js";
import {
  meetingPlatformCoverageSchema,
  meetingPlatformObservationSchema,
  type MeetingAudioClockMessage,
  type MeetingAudioClockAnchor,
  type MeetingPlatformCoverage,
  type MeetingPlatformObservation,
} from "../contracts/meetingRecording.js";

export interface MeetingPlatformEvidenceDatabase {
  saveMeetingPlatformObservation(observation: MeetingPlatformObservation): void;
  saveMeetingAudioClockAnchor(anchor: MeetingAudioClockAnchor): void;
  setMeetingPlatformCoverage(recordingId: string, coverage: MeetingPlatformCoverage): void;
}

/** Evidence failure never invokes the capture failure path. All writes are bounded
 * and deferred off PCM delivery. A new instance belongs to exactly one recording. */
export class ZoomSpeakerCollector {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private cleanupPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private coverage: MeetingPlatformCoverage = {
    reads: 0,
    samples: 0,
    state: "collecting",
    reason: null,
  };
  private failure: string | null = null;
  private coverageGap: string | null = null;
  private savedSamples = 0;
  private readonly queue: Array<() => void> = [];
  private draining: NodeJS.Immediate | null = null;
  private readonly audioClocks: MeetingAudioClockCollector;
  private lastMessageAt = Date.now();
  private watchdog: NodeJS.Timeout | null = null;

  constructor(
    private readonly recordingId: string,
    private readonly database: MeetingPlatformEvidenceDatabase,
    private readonly launch: (binary: string, args: string[]) => ChildProcessWithoutNullStreams = (
      binary,
      args
    ) => spawn(binary, args, { stdio: "pipe" })
  ) {
    this.audioClocks = new MeetingAudioClockCollector(recordingId, (anchor) =>
      database.saveMeetingAudioClockAnchor(anchor)
    );
  }

  start(): void {
    if (this.stopping || this.failure || this.child || process.platform !== "darwin") return;
    const binary = resolveBundledBinary("macos-meeting-ax", "meeting");

    if (!binary) {
      this.fail("ax-binary-unavailable");

      return;
    }

    const child = this.launch(binary, ["--collect-zoom", this.recordingId]);
    this.child = child;
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child === child) this.consume(chunk);
    });
    // Never log native output: participant names are private recording metadata.
    child.stderr.on("data", () => {});
    child.once("error", () => {
      if (this.child === child) this.fail("ax-helper-error");
    });
    child.once("close", () => {
      if (this.child === child) this.child = null;

      if (!this.stopping) this.fail("ax-helper-exited");
    });
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMessageAt > 8_000) this.fail("ax-helper-timeout");
    }, 2_000);
    this.watchdog.unref();
    this.enqueue(() => this.database.setMeetingPlatformCoverage(this.recordingId, this.coverage));
  }

  bindClock(generation: string, epochIndex: number, epochStartFrame: number): void {
    this.audioClocks.bindClock(generation, epochIndex, epochStartFrame);
  }
  recordDeliveredFrames(generation: string | undefined, frames: number): void {
    this.audioClocks.recordDeliveredFrames(generation, frames);
  }
  recordClock(clock: MeetingAudioClockMessage): void {
    if (!this.stopping) this.audioClocks.recordClock(clock);
  }
  invalidate(reason: string): void {
    this.fail(reason);
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer += this.decoder.write(chunk);

    if (this.buffer.length > 64 * 1024) {
      this.fail("ax-output-overflow");

      return;
    }

    let index: number;

    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);

      try {
        const message: unknown = JSON.parse(line);

        if (!message || typeof message !== "object") throw new Error();

        if ("type" in message && message.type === "observation" && "observation" in message) {
          const raw = message.observation;

          if (
            !raw ||
            typeof raw !== "object" ||
            !("sessionId" in raw) ||
            !("instanceKey" in raw) ||
            !("activity" in raw)
          )
            throw new Error();

          const observation = meetingPlatformObservationSchema.parse({
            ...raw,
            platform: "zoom",
            bindingId: raw.sessionId,
            activeParticipantIds:
              raw.activity === "explicit" || raw.activity === "end" ? [raw.instanceKey] : [],
            clockGeneration: null,
            clockUncertaintyNs: "0",
          });

          if (observation.recordingId !== this.recordingId) throw new Error();
          this.enqueue(() => {
            this.database.saveMeetingPlatformObservation(observation);
            this.savedSamples += 1;
            this.coverage.samples = this.savedSamples;
          });
        } else if ("type" in message && message.type === "coverage") {
          const coverage = meetingPlatformCoverageSchema.parse(message);
          this.coverageGap ??= coverage.reason;
          this.coverage = { ...coverage, samples: this.savedSamples };

          // The aggregate warning remembers a gap; closed activity ranges before
          // and after it remain usable. The matcher does not gate on this summary.
          if (this.coverageGap) this.coverage.reason = this.coverageGap;
          this.enqueue(() =>
            this.database.setMeetingPlatformCoverage(this.recordingId, {
              ...coverage,
              samples: this.savedSamples,
              state: this.failure || this.coverageGap ? "incomplete" : coverage.state,
              reason: this.failure ?? this.coverageGap ?? coverage.reason,
            })
          );
        } else throw new Error();
        this.lastMessageAt = Date.now();
      } catch {
        this.fail("ax-invalid-message");
      }
    }
  }

  private enqueue(write: () => void): void {
    if (this.failure) return;

    if (this.queue.length >= 128) {
      this.fail("metadata-queue-overflow");

      return;
    }

    this.queue.push(write);
    this.draining ??= setImmediate(() => this.drain());
  }

  private drain(): void {
    this.draining = null;

    while (this.queue.length && !this.failure) {
      try {
        this.queue.shift()!();
      } catch {
        this.fail("metadata-write-failed");
      }
    }
  }

  private fail(reason: string): void {
    this.failure ??= reason;
    this.queue.length = 0;
    void this.closeHelper(false);

    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;

    try {
      this.database.setMeetingPlatformCoverage(this.recordingId, {
        ...this.coverage,
        state: "incomplete",
        reason: this.failure,
      });
    } catch {
      // SQLite failure cannot truthfully persist its own marker. Startup marks
      // any remaining 'collecting' coverage incomplete; audio remains untouched.
    }
  }

  private closeHelper(flushing: boolean): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const child = this.child;

    if (!child) return Promise.resolve();
    this.cleanupPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          this.failure ??= "ax-helper-signal-failed";
        }

        if (flushing) this.failure ??= "ax-flush-timeout";
        resolve();
      }, 500);

      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        this.failure ??= "ax-helper-signal-failed";
      }
    });

    return this.cleanupPromise;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.finish();

    return this.stopPromise;
  }

  private async finish(): Promise<void> {
    this.stopping = true;

    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    await this.closeHelper(true);
    const decoderTail = this.decoder.end();

    if (decoderTail) this.failure ??= "metadata-tail-incomplete";
    const clockError = this.audioClocks.stop();
    this.failure ??= clockError;

    if (this.buffer.trim()) this.failure ??= "metadata-tail-incomplete";

    if (this.draining) clearImmediate(this.draining);
    this.drain();

    try {
      this.database.setMeetingPlatformCoverage(this.recordingId, {
        ...this.coverage,
        state: this.failure || this.coverage.reason ? "incomplete" : "complete",
        reason: this.failure ?? this.coverage.reason,
      });
    } catch {
      this.fail("metadata-write-failed");
    }
  }
}
