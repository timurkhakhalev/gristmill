import { useEffect, useState } from "react";

export interface UseWindowControlsReturn {
  isMaximized: boolean;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Shared state and handlers for legacy custom window-control buttons.
 */
export const useWindowControls = (): UseWindowControlsReturn => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;

    const syncIsMaximized = (): void => {
      // The probe owns its rejection: a failed read leaves the last known state
      // and the next tick retries, so callers (initial + interval) stay void.
      void window.electronAPI
        ?.windowIsMaximized?.()
        .then((maximized) => {
          if (mounted) setIsMaximized(Boolean(maximized));
        })
        .catch(() => {
          // Window mid-teardown or bridge unavailable; keep the last state.
        });
    };

    syncIsMaximized();
    // Polled because maximize can also happen outside these buttons (for
    // example, by double-clicking the drag band) and no renderer event reports it.
    const intervalId = window.setInterval(syncIsMaximized, 1000);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  // Best-effort window actions: they have no recovery path (the OS owns the
  // window), and the preload bridge can be absent during teardown. The state
  // poll above re-syncs the visible result after these resolve.
  const minimize = async (): Promise<void> => {
    try {
      await window.electronAPI?.windowMinimize?.();
    } catch {
      // No recovery path; the OS owns the window.
    }
  };

  const toggleMaximize = async (): Promise<void> => {
    try {
      await window.electronAPI?.windowMaximize?.();
      const maximized = await window.electronAPI?.windowIsMaximized?.();
      setIsMaximized(Boolean(maximized));
    } catch {
      // The maximize may still have applied; the next poll reflects it.
    }
  };

  const close = async (): Promise<void> => {
    try {
      await window.electronAPI?.windowClose?.();
    } catch {
      // No recovery path; the OS owns the window.
    }
  };

  return { isMaximized, minimize, toggleMaximize, close };
};
