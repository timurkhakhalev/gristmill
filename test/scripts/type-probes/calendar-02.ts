// @probe-name "wrong command args, results and event payloads fail compilation"
// @probe-codes [2322,2322,2339,2345,2345]
// @probe-origin test/scripts/calendarTypeProbe.test.js
import { createCalendarIntegrationBridge } from "./src/preload/calendarBridge.ts";
import { googleConnectionStatusSchema } from "./src/contracts/calendar.ts";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};
const bridge = createCalendarIntegrationBridge(ipcRendererLike);

// windowMinutes is a positive integer; a string is a compile-time error.
bridge.gcalGetUpcomingEvents("60");

// The event lookup takes an id, not a number.
bridge.gcalGetEvent(42);

// The Apple status event sourceNames is a string array, not a number.
bridge.onAcalConnectionChanged((data) => {
  const names: number = data.sourceNames;
  void names;
});

async function failureArm(): Promise<string> {
  const status = await bridge.gcalStartOAuth();
  if (status.success === false) {
    // email only exists on the success arm.
    return status.email;
  }
  return status.email;
}
void failureArm;

// Status parsing keeps absence-vs-false: configured stays optional.
const parsed = googleConnectionStatusSchema.parse({ connected: false, email: null });
const configured: boolean = parsed.configured;
void configured;
