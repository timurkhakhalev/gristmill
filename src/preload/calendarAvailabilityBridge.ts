// Renderer-facing calendar availability bridge. Moved out of preload.js so
// the one operation has a typed implementation backed by the shared
// contract. The response schema is a union of exact objects, so a
// misbehaving main-side mock carrying extra private fields (busy, events)
// fails validation instead of leaking them to the renderer. The sandboxed
// preload can't require local modules, so build-main.js bundles the final
// preload with esbuild.
import {
  availabilityResponseSchema,
  calendarAvailabilityChannels,
  type AvailabilityResponse,
  type CalendarAvailabilityApi,
  type CalendarAvailabilityRequestWire,
} from "../contracts/calendarAvailability.js";
import type { ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }
  return result.data;
}

// The return type is the shared CalendarAvailabilityApi, so any drift
// between this implementation and the contract fails compilation.
export function createCalendarAvailabilityBridge(
  ipcRenderer: IpcRendererLike
): CalendarAvailabilityApi {
  return {
    calendarGetAvailability: (
      request: CalendarAvailabilityRequestWire
    ): Promise<AvailabilityResponse> =>
      ipcRenderer
        .invoke(calendarAvailabilityChannels.getAvailability, request)
        .then((raw) =>
          parseResult(
            availabilityResponseSchema,
            raw,
            calendarAvailabilityChannels.getAvailability
          )
        ),
  };
}
