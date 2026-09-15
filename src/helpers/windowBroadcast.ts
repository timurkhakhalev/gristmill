import { BrowserWindow } from "electron";

export function broadcastToWindows(channel: string, data: unknown): void {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  });
}
