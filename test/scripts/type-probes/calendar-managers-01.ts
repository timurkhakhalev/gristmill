// @probe-name "wrong manager/OAuth/scheduler usage fails compilation"
// @probe-codes [2345,2345,2345,2345,2345,2554,2554,2554]
// @probe-origin test/scripts/calendarManagersTypeProbe.test.js
import { GoogleCalendarManager } from "./src/helpers/googleCalendarManager.ts";
import { MicrosoftCalendarManager } from "./src/helpers/microsoftCalendarManager.ts";
import { AppleCalendarManager } from "./src/helpers/appleCalendarManager.ts";
import { GoogleCalendarOAuth } from "./src/helpers/googleCalendarOAuth.ts";
import { MicrosoftCalendarOAuth } from "./src/helpers/microsoftCalendarOAuth.ts";
import { CalendarSyncInterval } from "./src/helpers/calendarSyncInterval.ts";
import { CalendarReminderScheduler } from "./src/helpers/calendarReminderScheduler.ts";
import { normalizeGraphDateTime } from "./src/helpers/microsoftCalendarManager.ts";

// Managers take (databaseManager, [windowManager], reminderScheduler); a
// database-only wiring must not compile.
new GoogleCalendarManager({});
new MicrosoftCalendarManager({});
new AppleCalendarManager({});

// The reminder scheduler needs the calendar DB surface, not any object.
new CalendarReminderScheduler({});

// Interval runner requires the full options object.
new CalendarSyncInterval(async () => {}, { intervalMs: 1000 });

// Graph datetime normalization takes { dateTime }, not a bare string.
normalizeGraphDateTime("2026-09-15T10:00:00.0000000", false);

// OAuth needs the token DB; a scheduler is not one.
new GoogleCalendarOAuth({});
new MicrosoftCalendarOAuth({});
