const debugLogger = require("./debugLogger");

const SHUTDOWN_DEADLINE_MS = 8000;

const sidecars: Array<{ name: string; stop: () => void | Promise<void> }> = [];

export function register(name: string, stopFn: () => void | Promise<void>): void {
  sidecars.push({ name, stop: stopFn });
}

export async function shutdownAll(): Promise<void> {
  if (sidecars.length === 0) return;

  const deadline = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS));
  const stops = Promise.allSettled(
    sidecars.map(async ({ name, stop }) => {
      try {
        await stop();
      } catch (err) {
        debugLogger.error("sidecar stop failed", { name, error: (err as Error | undefined)?.message });
      }
    })
  );
  await Promise.race([stops, deadline]);
}
