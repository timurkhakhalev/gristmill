import debugLogger from "./debugLogger.js";

export const FOCUS_SYNC_THROTTLE_MS = 30 * 1000;

export interface CalendarSyncIntervalOptions {
  intervalMs: number;
  maxIntervalMs: number;
  logScope: string;
}

// Interval runner for calendar REST providers: exponential backoff on
// consecutive failures (intervalMs × 2 per failure, capped at maxIntervalMs)
// and a 30s throttle on focus-triggered syncs.
export class CalendarSyncInterval {
  private readonly syncFn: () => Promise<void>;
  private readonly intervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly logScope: string;
  private timer: NodeJS.Timeout | null = null;
  private _consecutiveFailures = 0;
  private _lastFocusSync = 0;

  constructor(syncFn: () => Promise<void>, { intervalMs, maxIntervalMs, logScope }: CalendarSyncIntervalOptions) {
    this.syncFn = syncFn;
    this.intervalMs = intervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.logScope = logScope;
  }

  start(): void {
    this._consecutiveFailures = 0;
    this._schedule();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Resets the backoff after an out-of-band successful sync.
  notifySuccess(): void {
    if (this._consecutiveFailures > 0) {
      this._consecutiveFailures = 0;
      this._schedule();
    }
  }

  syncOnFocus(): void {
    const now = Date.now();
    if (now - this._lastFocusSync < FOCUS_SYNC_THROTTLE_MS) return;
    this._lastFocusSync = now;

    this.syncFn()
      .then(() => this.notifySuccess())
      .catch((err) =>
        debugLogger.error(
          "Focus-triggered sync failed",
          { error: (err as Error).message },
          this.logScope
        )
      );
  }

  private _schedule(): void {
    if (this.timer) clearInterval(this.timer);

    const interval = this._getInterval();
    debugLogger.info(
      "Calendar sync scheduled",
      { intervalMs: interval, consecutiveFailures: this._consecutiveFailures },
      this.logScope
    );

    this.timer = setInterval(() => {
      this.syncFn()
        .then(() => this.notifySuccess())
        .catch((err) => {
          this._consecutiveFailures++;
          debugLogger.error(
            "Calendar sync failed",
            {
              error: (err as Error).message,
              consecutiveFailures: this._consecutiveFailures,
              nextIntervalMs: this._getInterval(),
            },
            this.logScope
          );
          this._schedule();
        });
    }, interval);
  }

  private _getInterval(): number {
    if (this._consecutiveFailures === 0) return this.intervalMs;
    return Math.min(this.intervalMs * Math.pow(2, this._consecutiveFailures), this.maxIntervalMs);
  }
}

module.exports = CalendarSyncInterval;
module.exports.CalendarSyncInterval = CalendarSyncInterval;
module.exports.FOCUS_SYNC_THROTTLE_MS = FOCUS_SYNC_THROTTLE_MS;
