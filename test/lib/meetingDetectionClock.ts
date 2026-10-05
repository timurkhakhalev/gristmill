// One clock drives both AutoEnd intervals and notification cooldowns.
export function createMeetingDetectionClock() {
  let now = 10_000;
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; due: number; interval: number | null }>();

  const schedule = (callback: () => void, delay: number, interval: number | null) => {
    const id = nextId++;
    timers.set(id, { callback, due: now + delay, interval });

    return id;
  };

  return {
    now: () => now,
    setInterval: (callback: () => void, delay: number) => schedule(callback, delay, delay),
    clearInterval: (id: unknown) => typeof id === "number" && timers.delete(id),
    setTimeout: (callback: () => void, delay: number) => schedule(callback, delay, null),
    clearTimeout: (id: unknown) => typeof id === "number" && timers.delete(id),
    activeIntervals: () => [...timers.values()].filter((timer) => timer.interval !== null).length,
    activeTimeouts: () => [...timers.values()].filter((timer) => timer.interval === null).length,
    advance: (ms: number) => {
      const target = now + ms;

      while (true) {
        const next = [...timers]
          .filter(([, timer]) => timer.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];

        if (!next) break;
        const [id, timer] = next;
        now = timer.due;

        if (timer.interval === null) timers.delete(id);
        else timer.due += timer.interval;
        timer.callback();
      }

      now = target;
    },
  };
}
