// One clock drives both AutoEnd intervals and notification cooldowns.
export function createMeetingDetectionClock() {
  let now = 10_000;
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; due: number; interval: number | null }>();

  const schedule = (callback: () => void, delay: number, interval: number | null): number => {
    const id = nextId++;
    timers.set(id, { callback, due: now + delay, interval });

    return id;
  };

  const cancel = (id: number): boolean => timers.delete(id);

  return {
    now: () => now,
    setInterval: (callback: () => void, delay: number): number => schedule(callback, delay, delay),
    clearInterval: (id: number): boolean => cancel(id),
    setTimeout: (callback: () => void, delay: number): number => schedule(callback, delay, null),
    clearTimeout: (id: number): boolean => cancel(id),
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
