// The register-meeting-hotkey IPC handler, moved out of main.js: the typed
// owner of the "meeting" hotkey slot re-registration (settings UI path). The
// bootstrap slot registration and the shared callback stay in main.js, along
// with the menu/tray/window wiring and the notification preference gate.
import type { IpcMain } from "electron";

interface MeetingHotkeyManagerLike {
  registerSlot(
    slot: string,
    hotkey: string,
    callback: () => void,
    options?: { atomic?: boolean }
  ): Promise<{ success: boolean; error?: string }>;
  unregisterSlot(slot: string): unknown;
}

interface MeetingHotkeyEnvironmentLike {
  saveMeetingKey(hotkey: string): unknown;
}

export interface MeetingHotkeyHandlerDeps {
  ipcMain: Pick<IpcMain, "handle">;
  hotkeyManager: MeetingHotkeyManagerLike;
  environmentManager: MeetingHotkeyEnvironmentLike;
  // The same callback main.js registered at startup for the saved slot.
  meetingHotkeyCallback: () => void;
}

export function registerMeetingHotkeyHandler({
  ipcMain,
  hotkeyManager,
  environmentManager,
  meetingHotkeyCallback,
}: MeetingHotkeyHandlerDeps): void {
  ipcMain.handle("register-meeting-hotkey", async (_event, hotkey: string | null) => {
    if (hotkey) {
      const result = await hotkeyManager.registerSlot("meeting", hotkey, meetingHotkeyCallback, {
        atomic: true,
      });

      if (result.success) {
        environmentManager.saveMeetingKey(hotkey);

        return { success: true };
      }

      return { success: false, message: result.error };
    } else {
      hotkeyManager.unregisterSlot("meeting");
      environmentManager.saveMeetingKey("");

      return { success: true };
    }
  });
}
