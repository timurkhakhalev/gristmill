// @probe-name "a wrong bridge-level response usage fails compilation"
// @probe-codes [2339]
// @probe-origin test/scripts/calendarAvailabilityTypeProbe.test.js
import { createCalendarAvailabilityBridge } from "./src/preload/calendarAvailabilityBridge.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};
const bridge = createCalendarAvailabilityBridge(ipcRendererLike);

async function misuse(): Promise<number> {
  const response = await bridge.calendarGetAvailability({
    start: "2026-08-25T07:00:00.000Z",
    end: "2026-08-25T12:00:00.000Z",
  });
  // Availability only exists on the success arm of the union.
  return response.availability.availableSlots.length;
}
void misuse;
