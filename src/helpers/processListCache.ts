import debugLogger from "./debugLogger.js";

const CACHE_TTL_MS = 5000;

class ProcessListCache {
  private _cache: string[] | null = null;
  private _cacheTime = 0;
  private _pending: Promise<string[]> | null = null;

  async getProcessList(): Promise<string[]> {
    const now = Date.now();

    if (this._cache && now - this._cacheTime < CACHE_TTL_MS) {
      return this._cache;
    }

    if (this._pending) return this._pending;

    this._pending = this._fetch(now);

    try {
      return await this._pending;
    } finally {
      this._pending = null;
    }
  }

  async _fetch(now: number): Promise<string[]> {
    try {
      const psList = (await import("ps-list")).default;
      const procs = await psList();
      const names = procs.map((p) => (p.name || "").toLowerCase());
      this._cache = names;
      this._cacheTime = now;
      debugLogger.debug("Process list refreshed", { count: names.length }, "meeting");

      return names;
    } catch (err) {
      debugLogger.warn(
        "Failed to fetch process list",
        { error: err instanceof Error ? err.message : String(err) },
        "meeting"
      );

      return [];
    }
  }

  invalidate(): void {
    this._cache = null;
    this._cacheTime = 0;
    this._pending = null;
  }
}

export const processListCache = new ProcessListCache();

module.exports = processListCache;

// Named re-attach for TS consumers importing { processListCache }.
module.exports.processListCache = processListCache;
