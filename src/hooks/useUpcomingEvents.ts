import { useState, useEffect, useCallback } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import type { CalendarEvent } from "../contracts/calendar";
import { hasOtherAttendees } from "../utils/calendarAttendees";

export interface UseUpcomingEventsReturn {
  events: CalendarEvent[];
  isLoading: boolean;
  isConnected: boolean;
}

const LOOKAHEAD_DAYS = 7;

function getLookaheadMinutes(): number {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + LOOKAHEAD_DAYS);
  end.setHours(0, 0, 0, 0);

  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 60000));
}

// Last fetched list, kept across Home remounts so returning to Home paints the
// previous events at once and refreshes them in the background.
let cachedEvents: CalendarEvent[] | null = null;

export function useUpcomingEvents(): UseUpcomingEventsReturn {
  const gcalAccounts = useSettingsStore((s) => s.gcalAccounts);
  const mcalAccounts = useSettingsStore((s) => s.mcalAccounts);
  const appleCalendarConnected = useSettingsStore((s) => s.appleCalendarConnected);
  const isConnected = gcalAccounts.length > 0 || mcalAccounts.length > 0 || appleCalendarConnected;

  const [events, setEvents] = useState<CalendarEvent[]>(() => cachedEvents ?? []);
  // Loading until the first fetch lands; starting false painted "No events" first.
  const [isLoading, setIsLoading] = useState(() => isConnected && cachedEvents == null);

  const fetchEvents = useCallback(async () => {
    const apply = (next: CalendarEvent[]) => {
      cachedEvents = next;
      setEvents(next);
    };

    if (!isConnected) {
      apply([]);
      setIsLoading(false);

      return;
    }

    if (cachedEvents == null) setIsLoading(true);

    try {
      const windowMinutes = getLookaheadMinutes();
      const result = await window.electronAPI?.gcalGetUpcomingEvents(windowMinutes);
      apply(result?.success ? result.events.filter(hasOtherAttendees) : []);
    } catch {
      apply([]);
    } finally {
      setIsLoading(false);
    }
  }, [isConnected]);

  // Fetch on mount and when connection status changes
  useEffect(() => {
    fetchEvents().catch(() => {});
  }, [fetchEvents]);

  // Re-fetch when any provider syncs events
  useEffect(() => {
    if (!isConnected) return;

    const unsubGcal = window.electronAPI?.onGcalEventsSynced(() => {
      fetchEvents().catch(() => {});
    });

    const unsubMcal = window.electronAPI?.onMcalEventsSynced(() => {
      fetchEvents().catch(() => {});
    });

    const unsubAcal = window.electronAPI?.onAcalEventsSynced(() => {
      fetchEvents().catch(() => {});
    });

    return () => {
      unsubGcal?.();
      unsubMcal?.();
      unsubAcal?.();
    };
  }, [isConnected, fetchEvents]);

  return { events, isLoading, isConnected };
}
