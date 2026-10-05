// The calendar-get-availability IPC handler, moved out of ipcHandlers.js.
// Thin adapter: logging and the Error/non-Error message policy live here,
// the domain validation/computation stays in the pure calculation module
// and the service. Wire responses are validated so extra fields from a
// misbehaving provider mock (busy, events) can never leak to the renderer.
import type { ZodType } from "zod";
import {
  availabilityResponseSchema,
  calendarAvailabilityChannels,
  type AvailabilityResponse,
} from "../contracts/calendarAvailability.js";
import type {
  CalendarAvailabilityServiceDeps,
  CalendarProviderEntry,
} from "./calendarAvailabilityService.js";
import { getCalendarAvailability } from "./calendarAvailabilityService.js";

export interface CalendarAvailabilityHandlerDeps {
  databaseManager: CalendarAvailabilityServiceDeps["databaseManager"];
  calendarProviders: CalendarProviderEntry[];
  clock?: () => Date;
  logWarn: (message: string, data?: unknown, tag?: string) => void;
}

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

function parseResponse<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error("Calendar availability returned an unexpected response shape");
  }

  return result.data;
}

export function registerCalendarAvailabilityHandler(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: CalendarAvailabilityHandlerDeps
): void {
  ipcMain.handle(
    calendarAvailabilityChannels.getAvailability,
    async (_event, ...args: unknown[]): Promise<AvailabilityResponse> => {
      try {
        const availability = getCalendarAvailability({
          request: args[0],
          databaseManager: deps.databaseManager,
          calendarProviders: deps.calendarProviders,
          clock: deps.clock,
        });

        return parseResponse(availabilityResponseSchema, {
          success: true as const,
          availability,
        });
      } catch (error) {
        deps.logWarn(
          "Calendar availability request failed",
          { error: error instanceof Error ? error.message : String(error) },
          "calendar"
        );

        return {
          success: false as const,
          error: error instanceof Error ? error.message : "Failed to check calendar availability",
        } satisfies AvailabilityResponse;
      }
    }
  );
}
