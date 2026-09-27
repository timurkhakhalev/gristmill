// @probe-name "incomplete manager wiring fails compilation"
// @probe-codes [2345]
// @probe-origin test/scripts/calendarTypeProbe.test.js
import { registerCalendarIntegrationHandlers } from "./src/helpers/calendarIpcHandlers.ts";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

// Missing getUpcomingEvents/getCalendarEventById and the Apple manager would
// silently break the neutral reads; the compiler must reject the registration.
registerCalendarIntegrationHandlers(ipcMain, {
  googleManager: {
    startOAuth: async () => ({ success: true, email: "g@x.io" }),
    disconnect: () => {},
    getConnectionStatus: () => ({ connected: false, email: null }),
    getCalendars: () => [],
    setCalendarSelection: async () => {},
    setPrimaryOnly: async () => {},
    syncEvents: async () => {},
  },
  microsoftManager: {
    startOAuth: async () => ({ success: true }),
    disconnect: () => {},
    getConnectionStatus: () => ({ connected: false, accounts: [] }),
    setPrimaryOnly: async () => {},
  },
  openCalendarPrivacySettings: async () => ({ success: true }),
  logError: () => {},
});
