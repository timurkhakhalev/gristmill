const debugLogger = require("./debugLogger");

const SHUTDOWN_DEADLINE_MS = 8000;

const sidecars: Array<{ name: string; stop: () => void | Promise<void> }> = [];

export function register(name: string, stopFn: () => void | Promise<void>): void {
  sidecars.push({ name, stop: stopFn });
}

export async function shutdownAll(settleOwnedWork: () => Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;

  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      debugLogger.error("Shutdown deadline expired; owned work or sidecars did not settle", {
        deadlineMs: SHUTDOWN_DEADLINE_MS,
      });
      resolve(false);
    }, SHUTDOWN_DEADLINE_MS);
  });

  const stops = (async () => {
    try {
      await settleOwnedWork();
    } catch (error) {
      debugLogger.error("Shutdown work barrier failed", { error: (error as Error)?.message });

      return false;
    }

    // A timed-out barrier may settle later. Do not start freeing its engines.
    if (expired) return false;

    const results = await Promise.all(
      sidecars.map(async ({ name, stop }) => {
        try {
          await stop();

          return true;
        } catch (error) {
          debugLogger.error("sidecar stop failed", { name, error: (error as Error)?.message });

          return false;
        }
      })
    );

    return results.every(Boolean);
  })();

  try {
    return await Promise.race([stops, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
