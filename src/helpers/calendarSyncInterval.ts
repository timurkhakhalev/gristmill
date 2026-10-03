import debugLogger from "./debugLogger.js";

export const FOCUS_SYNC_THROTTLE_MS = 30 * 1000;

// The whole-pass result of one calendar sync: the orchestration needs an
// explicit outcome because the managers swallow per-calendar errors to keep
// best-effort updates for the calendars that did succeed. `failed > 0` means
// at least one calendar errored; `succeeded === 0` with `failed > 0` is a full
// provider failure. A resolved promise is no longer a success on its own.
export interface CalendarSyncOutcome {
  total: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

export interface CalendarSyncIntervalOptions {
  intervalMs: number;
  maxIntervalMs: number;
  logScope: string;
}

export function isCalendarSyncFailure(outcome: CalendarSyncOutcome | void): boolean {
  return Boolean(outcome && outcome.failed > 0);
}

// Interval runner for calendar REST providers: exponential backoff on
// consecutive failures (intervalMs × 2 per failure, capped at maxIntervalMs)
// and a 30s throttle on focus-triggered syncs. A sync reports failure through
// either a rejected promise or a resolved outcome with `failed > 0`; only a
// clean outcome resets the backoff. A completion that lands after stop never
// resurrects the timer.
export class CalendarSyncInterval {
  private readonly syncFn: () => Promise<CalendarSyncOutcome | void>;
  private readonly intervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly logScope: string;
  private timer: NodeJS.Timeout | null = null;
  private _running = false;
  private _consecutiveFailures = 0;
  private _lastFocusSync = 0;

  constructor(syncFn: () => Promise<CalendarSyncOutcome | void>, { intervalMs, maxIntervalMs, logScope }: CalendarSyncIntervalOptions) {
    this.syncFn = syncFn;
    this.intervalMs = intervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.logScope = logScope;
  }

  start(): void {
    this._running = true;
    this._consecutiveFailures = 0;
    this._schedule();
  }

  stop(): void {
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Resets the backoff after an out-of-band sync that fully succeeded, or
  // records the failure so the next scheduled run already backs off.
  notifyOutcome(outcome: CalendarSyncOutcome | void): void {
    if (isCalendarSyncFailure(outcome)) {
      this._recordFailure(outcome as CalendarSyncOutcome);
      return;
    }
    if (this._consecutiveFailures > 0) {
      this._consecutiveFailures = 0;
      this._rescheduleIfRunning();
    }
  }

  // Resets the backoff after an out-of-band successful sync.
  notifySuccess(): void {
    this.notifyOutcome(undefined);
  }

  syncOnFocus(): void {
    const now = Date.now();
    if (now - this._lastFocusSync < FOCUS_SYNC_THROTTLE_MS) return;
    this._lastFocusSync = now;

    this.syncFn()
      .then((outcome) => this.notifyOutcome(outcome))
      .catch((err) => {
        debugLogger.error(
          "Focus-triggered sync failed",
          { error: (err as Error).message },
          this.logScope
        );
      });
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
        .then((outcome) => this.notifyOutcome(outcome))
        .catch((err) => {
          this._recordFailure({ total: 0, succeeded: 0, failed: 1, errors: [(err as Error).message] });
        });
    }, interval);
  }

  private _recordFailure(outcome: CalendarSyncOutcome): void {
    this._consecutiveFailures++;
    debugLogger.error(
      "Calendar sync failed",
      {
        error: describeOutcome(outcome),
        consecutiveFailures: this._consecutiveFailures,
        nextIntervalMs: this._getInterval(),
      },
      this.logScope
    );
    this._rescheduleIfRunning();
  }

  // A completion that lands after stop must not restart the timer.
  private _rescheduleIfRunning(): void {
    if (this._running) this._schedule();
  }

  private _getInterval(): number {
    if (this._consecutiveFailures === 0) return this.intervalMs;
    return Math.min(this.intervalMs * Math.pow(2, this._consecutiveFailures), this.maxIntervalMs);
  }
}

function describeOutcome(outcome: CalendarSyncOutcome): string {
  return outcome.errors[0] || `${outcome.failed}/${outcome.total} calendars failed`;
}

module.exports = CalendarSyncInterval;
module.exports.CalendarSyncInterval = CalendarSyncInterval;
module.exports.FOCUS_SYNC_THROTTLE_MS = FOCUS_SYNC_THROTTLE_MS;
module.exports.isCalendarSyncFailure = isCalendarSyncFailure;
