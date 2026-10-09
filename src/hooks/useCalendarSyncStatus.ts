import { useEffect, useState } from "react";
import type { CalendarSyncStatus } from "../contracts/calendar";
import { useSettingsStore } from "../stores/settingsStore";

const pending: CalendarSyncStatus = { state: "pending", requiresReconnect: false };

const unavailable: CalendarSyncStatus = { state: "error", requiresReconnect: false };

/** Read the managers' live sync results, including failed background updates. */
export function useCalendarSyncStatus() {
  const [google, setGoogle] = useState(pending);
  const [microsoft, setMicrosoft] = useState(pending);

  useEffect(() => {
    let disposed = false;
    let googleRevision = 0;
    let microsoftRevision = 0;

    const refreshGoogle = () => {
      const revision = ++googleRevision;
      window.electronAPI
        .gcalGetConnectionStatus()
        .then((status) => {
          if (disposed || revision !== googleRevision) return;

          if (status.configured !== undefined) {
            useSettingsStore.getState().setGcalAccounts(status.accounts ?? []);
          }

          setGoogle(status.sync);
        })
        .catch(() => {
          if (!disposed && revision === googleRevision) setGoogle(unavailable);
        });
    };

    const refreshMicrosoft = () => {
      const revision = ++microsoftRevision;
      window.electronAPI
        .mcalGetConnectionStatus()
        .then((status) => {
          if (disposed || revision !== microsoftRevision) return;

          if (status.configured !== undefined) {
            useSettingsStore.getState().setMcalAccounts(status.accounts);
          }

          setMicrosoft(status.sync);
        })
        .catch(() => {
          if (!disposed && revision === microsoftRevision) setMicrosoft(unavailable);
        });
    };

    const unsubscribers = [
      window.electronAPI.onGcalEventsSynced(refreshGoogle),
      window.electronAPI.onGcalConnectionChanged(refreshGoogle),
      window.electronAPI.onMcalEventsSynced(refreshMicrosoft),
      window.electronAPI.onMcalConnectionChanged(refreshMicrosoft),
    ];

    refreshGoogle();
    refreshMicrosoft();

    return () => {
      disposed = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  return { google, microsoft };
}
