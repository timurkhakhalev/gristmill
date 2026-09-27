// @probe-name "the full registration, service and bridge compile under strict settings"
// @probe-codes []
// @probe-origin test/scripts/calendarAvailabilityTypeProbe.test.js
import { registerCalendarAvailabilityHandler } from "./src/helpers/calendarAvailabilityIpcHandler.js";
import { createCalendarAvailabilityBridge } from "./src/preload/calendarAvailabilityBridge.js";
import { validateCalendarAvailabilityRequest, computeCalendarAvailability } from "./src/helpers/calendarAvailability.js";
import type { AvailabilityResult } from "./src/contracts/calendarAvailability.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerCalendarAvailabilityHandler(ipcMain, {
  databaseManager: { getCalendarEventsInRange: () => [] },
  calendarProviders: [
    { provider: "google", manager: { isConnected: () => true } },
    { provider: "apple", manager: { isConnected: () => true } },
  ],
  clock: () => new Date("2026-08-25T06:00:00.000Z"),
  logWarn: () => {},
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createCalendarAvailabilityBridge(ipcRendererLike);
async function useResponse(): Promise<string[]> {
  const response = await bridge.calendarGetAvailability({
    start: "2026-08-25T07:00:00.000Z",
    end: "2026-08-25T12:00:00.000Z",
  });
  if (!response.success) return [response.error];
  return response.availability.availableSlots.map((slot) => slot.start);
}
void useResponse;

const normalized = validateCalendarAvailabilityRequest({
  start: "2026-08-25T07:00:00.000Z",
  end: "2026-08-25T12:00:00.000Z",
}, new Date("2026-08-25T06:00:00.000Z"));
const computed = computeCalendarAvailability([], normalized);
const slots: number = computed.availableSlots.length;
void slots;

const result: AvailabilityResult | null = null;
void result;
