// @probe-name "an incomplete dependency set fails compilation"
// @probe-codes [2345]
// @probe-origin test/scripts/calendarAvailabilityTypeProbe.test.js
import { registerCalendarAvailabilityHandler } from "./src/helpers/calendarAvailabilityIpcHandler.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

// A handler without calendarProviders would never see a connected calendar;
// the compiler must reject the registration.
registerCalendarAvailabilityHandler(ipcMain, {
  databaseManager: { getCalendarEventsInRange: () => [] },
  logWarn: () => {},
});
