import { screen, BrowserWindow } from "electron";
import { WindowPositionUtil } from "./windowConfig.js";
import debugLogger from "./debugLogger.js";

export interface DragOperationResult {
  success: boolean;
  message?: string;
}

interface DragOffset {
  x: number;
  y: number;
}

export class DragManager {
  isDragging = false;
  dragOffset = { x: 0, y: 0 };
  mouseTrackingInterval: NodeJS.Timeout | null = null;
  targetWindow: BrowserWindow | null = null;
  activeWindow: BrowserWindow | null = null;

  setTargetWindow(window: BrowserWindow | null): void {
    this.targetWindow = window;
  }

  /** Drags the configured target window by default; a caller that owns a
   *  different frameless window (the control panel's manual titlebar) passes
   *  it explicitly for the duration of one drag. */
  async startWindowDrag(windowOverride: BrowserWindow | null = null): Promise<DragOperationResult> {
    const win = windowOverride || this.targetWindow;

    if (!win || win.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    try {
      this.isDragging = true;
      this.activeWindow = win;

      // Get current cursor position
      const cursorPos = screen.getCursorScreenPoint();
      const windowPos = win.getPosition();

      // Calculate offset from cursor to window position
      this.dragOffset = {
        x: cursorPos.x - windowPos[0],
        y: cursorPos.y - windowPos[1],
      };

      // Start tracking mouse movements
      this.setupMouseTracking();

      debugLogger.info("Window drag started", undefined, "window-drag");

      return { success: true };
    } catch (error) {
      console.error("Failed to start window drag:", error);
      this.isDragging = false;

      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async stopWindowDrag(): Promise<DragOperationResult> {
    try {
      this.isDragging = false;
      this.activeWindow = null;
      this.stopMouseTracking();
      debugLogger.info("Window drag stopped", undefined, "window-drag");

      return { success: true };
    } catch (error) {
      console.error("Failed to stop window drag:", error);

      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  setupMouseTracking(): void {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
    }

    this.mouseTrackingInterval = setInterval(() => {
      if (this.isDragging && this.activeWindow && !this.activeWindow.isDestroyed()) {
        this.updateWindowPosition();
      }
    }, 16); // ~60fps
  }

  updateWindowPosition(): void {
    const win = this.activeWindow;

    if (!win || win.isDestroyed()) return;

    try {
      const cursorPos = screen.getCursorScreenPoint();
      const { width, height } = win.getBounds();
      const x = cursorPos.x - this.dragOffset.x;
      const y = cursorPos.y - this.dragOffset.y;

      // Constrain against the display the window lands on, not the one under the
      // cursor: near a boundary between differently sized displays, the cursor's
      // work area permits positions that leave the window in dead space.
      const display = screen.getDisplayNearestPoint({
        x: x + width / 2,
        y: y + height / 2,
      });

      const clamped = WindowPositionUtil.clampToWorkArea({ x, y, width, height }, display);

      win.setPosition(clamped.x, clamped.y);
    } catch (error) {
      console.error("Error updating window position:", error);
      // Fire-and-forget by contract: the caller is the tracking interval, which
      // has no rejection path. stopWindowDrag already contains its failures.
      this.stopWindowDrag().catch((stopError) =>
        console.error("Failed to stop window drag:", stopError)
      );
    }
  }

  stopMouseTracking(): void {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
      this.mouseTrackingInterval = null;
    }
  }

  isDragActive(): boolean {
    return this.isDragging;
  }

  getDragOffset(): DragOffset {
    return { ...this.dragOffset };
  }

  cleanup(): void {
    this.stopWindowDrag().catch((error) =>
      console.error("Failed to stop window drag during cleanup:", error)
    );
    this.targetWindow = null;
  }
}

module.exports = DragManager;

// Dual export: legacy requires read this module as the class itself, while the
// TS graph imports the named class.
Object.assign(module.exports, { DragManager });
