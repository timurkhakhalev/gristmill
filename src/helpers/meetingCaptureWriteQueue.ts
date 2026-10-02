const SAMPLE_RATE = 24_000;
export const MAX_UNACKNOWLEDGED_CAPTURE_MS = 5000;
export const MAX_UNACKNOWLEDGED_CAPTURE_FRAMES = SAMPLE_RATE * MAX_UNACKNOWLEDGED_CAPTURE_MS / 1000;
export const MAX_CAPTURE_ACK_AGE_MS = 10000;

export interface MeetingCaptureWriteQueueOptions<T> {
  write(packet: T): Promise<unknown>;
  onFailure(error: Error): void;
  now?: () => number;
  maxFrames?: number;
  maxAgeMs?: number;
}

/** Serial, bounded write-before-ack queue shared by each renderer source. */
export class MeetingCaptureWriteQueue<T> {
  private readonly pending = new Set<{
    frames: number;
    timer: ReturnType<typeof setTimeout>;
    reject: (error: Error) => void;
  }>();
  private readonly now: () => number;
  private readonly maxFrames: number;
  private readonly maxAgeMs: number;
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private closed = false;
  private pendingFrames = 0;
  private failureResolver: ((error: Error) => void) | null = null;
  private readonly failed = new Promise<Error>((resolve) => {
    this.failureResolver = resolve;
  });

  constructor(private readonly options: MeetingCaptureWriteQueueOptions<T>) {
    this.now = options.now ?? Date.now;
    this.maxFrames = options.maxFrames ?? MAX_UNACKNOWLEDGED_CAPTURE_FRAMES;
    this.maxAgeMs = options.maxAgeMs ?? MAX_CAPTURE_ACK_AGE_MS;
  }

  get unacknowledgedFrames(): number {
    return this.pendingFrames;
  }

  write(packet: T, frames: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("Meeting capture write queue is closed"));
    if (!Number.isSafeInteger(frames) || frames < 1 || this.pendingFrames + frames > this.maxFrames) {
      const error = new Error(`Meeting capture exceeded the ${MAX_UNACKNOWLEDGED_CAPTURE_MS} ms write backlog`);
      this.fail(error);
      return Promise.reject(error);
    }

    this.pendingFrames += frames;
    let item: { frames: number; timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void };
    const promise = new Promise<void>((resolve, reject) => {
      item = {
        frames,
        reject,
        timer: setTimeout(() => {
          const error = new Error(`Meeting capture write acknowledgement exceeded ${this.maxAgeMs} ms`);
          this.fail(error);
        }, this.maxAgeMs),
      };
      this.pending.add(item);
      this.tail = this.tail
        .then(() => {
          if (this.failure) throw this.failure;
          return this.options.write(packet);
        })
        .then(() => {
          this.settle(item, resolve);
        }, (reason: unknown) => {
          const error = reason instanceof Error ? reason : new Error(String(reason));
          this.fail(error);
          this.settle(item, () => reject(error));
        });
    });
    return promise;
  }

  drain(): Promise<void> {
    this.closed = true;
    return this.waitForWrites();
  }

  /** Wait for accepted packets without closing the queue used after unmute. */
  async waitForWrites(): Promise<void> {
    const outcome = await Promise.race([
      this.tail.then(() => null),
      this.failed,
    ]);
    if (outcome) throw outcome;
    if (this.failure) throw this.failure;
  }

  private settle(
    item: { frames: number; timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void },
    callback: () => void
  ): void {
    if (!this.pending.delete(item)) return;
    clearTimeout(item.timer);
    this.pendingFrames -= item.frames;
    callback();
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.failureResolver?.(error);
    this.failureResolver = null;
    for (const item of this.pending) {
      clearTimeout(item.timer);
      this.pendingFrames -= item.frames;
      item.reject(error);
    }
    this.pending.clear();
    this.options.onFailure(error);
  }
}
