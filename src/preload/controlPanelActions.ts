interface ActionIpc {
  on(channel: string, listener: (event: unknown, data?: unknown) => void): unknown;
}

/** Preload owns commands until the mounted ControlPanel installs its handler. */
export function createControlPanelActionSubscriptions(ipc: ActionIpc) {
  const retain = <T>(channel: string) => {
    const pending: T[] = [];
    let current: ((data: T) => void) | null = null;
    ipc.on(channel, (_event, data) => {
      // SAFETY: retain<T> names the payload the main-side sender serializes
      // for this channel; the queued replay preserves that same type.
      const value = data as T;

      if (current) current(value);
      else pending.push(value);
    });

    return (callback: (data: T) => void) => {
      current = callback;

      for (const data of pending.splice(0)) callback(data);

      return () => {
        if (current === callback) current = null;
      };
    };
  };

  return {
    onTrayNewNote: retain<void>("tray-new-note"),
    onTrayOpenEvent: retain<unknown>("tray-open-event"),
    onShowSettings: retain<void>("show-settings"),
  };
}
