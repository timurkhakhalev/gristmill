import { app, screen, BrowserWindow } from "electron";
import debugLogger from "./debugLogger.js";
import { DevServerManager } from "./devServerManager.js";
import { NOTIFICATION_WINDOW_CONFIG, WindowPositionUtil } from "./windowConfig.js";
import {
  INACTIVE_MEETING_COMPANION_STATE,
  meetingCompanionChannels,
  meetingCompanionEventChannels,
  meetingCompanionLevelSchema,
  meetingCompanionPointSchema,
  meetingCompanionStateSchema,
  type MeetingCompanionState,
} from "../contracts/meetingCompanion.js";
import {
  MEETING_COMPANION_SIZE,
  clampToWorkArea,
  defaultCompanionPosition,
  shouldShowMeetingCompanion,
  type Point,
} from "./meetingCompanionPolicy.js";

interface MeetingCompanionDeps {
  getControlPanelWindow: () => BrowserWindow | null;
  openNote: (payload: { noteId: number; folderId: number | null }) => void | Promise<void>;
}

/**
 * Owns the recording companion window: created while a meeting records,
 * shown whenever the control panel loses focus, destroyed when recording ends.
 * The position survives hide/show within a session.
 */
export class MeetingCompanionWindow {
  private win: BrowserWindow | null = null;
  private loaded = false;
  private state: MeetingCompanionState = INACTIVE_MEETING_COMPANION_STATE;
  private position: Point | null = null;
  private dragOrigin: { pointer: Point; window: Point } | null = null;

  constructor(private readonly deps: MeetingCompanionDeps) {
    // Focus moves settle after the blur event, so re-evaluate on the next tick.
    const reconcileSoon = () => setImmediate(() => this.reconcile());
    app.on("browser-window-focus", reconcileSoon);
    app.on("browser-window-blur", reconcileSoon);
  }

  update(state: MeetingCompanionState): void {
    this.state = state;

    if (!state.active) {
      this.destroy();

      return;
    }

    this.send(meetingCompanionEventChannels.state, state);
    this.reconcile();
  }

  setLevel(level: number): void {
    if (this.win?.isVisible()) this.send(meetingCompanionEventChannels.level, level);
  }

  dragStart(pointer: Point): void {
    if (!this.win || this.win.isDestroyed()) return;
    const [x, y] = this.win.getPosition();
    this.dragOrigin = { pointer, window: { x, y } };
  }

  dragMove(pointer: Point): void {
    if (!this.win || this.win.isDestroyed() || !this.dragOrigin) return;

    const next = {
      x: this.dragOrigin.window.x + pointer.x - this.dragOrigin.pointer.x,
      y: this.dragOrigin.window.y + pointer.y - this.dragOrigin.pointer.y,
    };

    const { workArea } = screen.getDisplayNearestPoint(pointer);
    this.position = clampToWorkArea(next, workArea, MEETING_COMPANION_SIZE);
    this.win.setPosition(this.position.x, this.position.y);
  }

  open(): void {
    this.dragOrigin = null;
    const { noteId, folderId } = this.state;

    if (noteId == null) return;
    void this.deps.openNote({ noteId, folderId });
  }

  /** Relays the bubble's mute button to the control panel, which owns the recording. */
  requestMicToggle(): void {
    const panel = this.deps.getControlPanelWindow();

    if (panel && !panel.isDestroyed()) {
      panel.webContents.send(meetingCompanionEventChannels.toggleMic);
    }
  }

  handleReady(): void {
    this.loaded = true;
    this.send(meetingCompanionEventChannels.state, this.state);
    this.reconcile();
  }

  /** Pointer and ready messages count only when they come from the bubble itself. */
  ownsSender(sender: unknown): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.webContents === sender);
  }

  destroy(): void {
    const win = this.win;
    this.win = null;
    this.loaded = false;
    this.dragOrigin = null;

    if (win && !win.isDestroyed()) win.destroy();
  }

  private isControlPanelFocused(): boolean {
    const panel = this.deps.getControlPanelWindow();

    return Boolean(panel && !panel.isDestroyed() && panel.isVisible() && panel.isFocused());
  }

  private reconcile(): void {
    if (!shouldShowMeetingCompanion(this.state.active, this.isControlPanelFocused())) {
      this.dragOrigin = null;

      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();

      return;
    }

    const win = this.ensureWindow();

    if (this.loaded && !win.isVisible()) win.showInactive();
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;

    const display = this.position
      ? screen.getDisplayNearestPoint(this.position)
      : screen.getPrimaryDisplay();

    const position = clampToWorkArea(
      this.position ?? defaultCompanionPosition(display.workArea, MEETING_COMPANION_SIZE),
      display.workArea,
      MEETING_COMPANION_SIZE
    );

    this.position = position;

    const win = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      width: MEETING_COMPANION_SIZE.width,
      height: MEETING_COMPANION_SIZE.height,
      ...position,
    });

    this.win = win;
    this.loaded = false;
    win.setContentProtection(true);
    WindowPositionUtil.setupAlwaysOnTop(win, { level: "floating" });
    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.loaded = false;
      }
    });

    const load = async () => {
      if (process.env.NODE_ENV === "development") {
        await DevServerManager.waitForDevServer();

        if (this.win !== win) return;
        await win.loadURL(`${DevServerManager.DEV_SERVER_URL}?meeting-companion=true`);

        return;
      }

      const fileInfo = DevServerManager.getAppFilePath(false)!;
      await win.loadFile(fileInfo.path, {
        query: { ...fileInfo.query, "meeting-companion": "true" },
      });
    };

    load().catch((error: unknown) => {
      debugLogger.warn(
        "Meeting companion failed to load",
        { error: (error as Error).message },
        "meeting"
      );

      if (this.win === win) this.destroy();
    });

    return win;
  }

  private send(channel: string, payload: unknown): void {
    const win = this.win;

    if (!win || win.isDestroyed() || !this.loaded) return;
    win.webContents.send(channel, payload);
  }
}

interface IpcMainLike {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

export function registerMeetingCompanionHandlers(
  ipcMain: IpcMainLike,
  companion: MeetingCompanionWindow
): void {
  ipcMain.on(meetingCompanionChannels.update, (_event, raw) => {
    const parsed = meetingCompanionStateSchema.safeParse(raw);

    if (parsed.success) companion.update(parsed.data);
  });
  ipcMain.on(meetingCompanionChannels.level, (_event, raw) => {
    const parsed = meetingCompanionLevelSchema.safeParse(raw);

    if (parsed.success) companion.setLevel(parsed.data);
  });

  const fromCompanion = (event: unknown) =>
    companion.ownsSender((event as { sender?: unknown } | null)?.sender);

  ipcMain.on(meetingCompanionChannels.dragStart, (event, ...args) => {
    const parsed = meetingCompanionPointSchema.safeParse(args);

    if (parsed.success && fromCompanion(event))
      companion.dragStart({ x: parsed.data[0], y: parsed.data[1] });
  });
  ipcMain.on(meetingCompanionChannels.dragMove, (event, ...args) => {
    const parsed = meetingCompanionPointSchema.safeParse(args);

    if (parsed.success && fromCompanion(event))
      companion.dragMove({ x: parsed.data[0], y: parsed.data[1] });
  });
  ipcMain.on(meetingCompanionChannels.open, (event) => {
    if (fromCompanion(event)) companion.open();
  });
  ipcMain.on(meetingCompanionChannels.toggleMic, (event) => {
    if (fromCompanion(event)) companion.requestMicToggle();
  });
  ipcMain.on(meetingCompanionChannels.ready, (event) => {
    if (fromCompanion(event)) companion.handleReady();
  });
}
