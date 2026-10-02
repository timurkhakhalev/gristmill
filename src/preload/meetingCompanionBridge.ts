// Renderer-facing bridge for the recording companion. Everything is
// fire-and-forget: state and level stream at frame rate, so nothing awaits.
import {
  meetingCompanionChannels,
  meetingCompanionEventChannels,
  meetingCompanionLevelSchema,
  meetingCompanionStateSchema,
  type MeetingCompanionApi,
  type MeetingCompanionState,
} from "../contracts/meetingCompanion.js";

interface IpcRendererLike {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void
  ): unknown;
}

export function createMeetingCompanionBridge(ipcRenderer: IpcRendererLike): MeetingCompanionApi {
  const subscribe = <T>(
    channel: string,
    parse: (raw: unknown) => T | undefined,
    callback: (value: T) => void
  ) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event: unknown, raw: unknown) => {
      const value = parse(raw);
      if (value !== undefined) callback(value);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };

  return {
    updateMeetingCompanion: (state: MeetingCompanionState) =>
      ipcRenderer.send(meetingCompanionChannels.update, state),
    sendMeetingCompanionLevel: (level: number) =>
      ipcRenderer.send(meetingCompanionChannels.level, level),
    meetingCompanionDragStart: (screenX: number, screenY: number) =>
      ipcRenderer.send(meetingCompanionChannels.dragStart, screenX, screenY),
    meetingCompanionDragMove: (screenX: number, screenY: number) =>
      ipcRenderer.send(meetingCompanionChannels.dragMove, screenX, screenY),
    openMeetingCompanionNote: () => ipcRenderer.send(meetingCompanionChannels.open),
    meetingCompanionReady: () => ipcRenderer.send(meetingCompanionChannels.ready),
    meetingCompanionToggleMic: () => ipcRenderer.send(meetingCompanionChannels.toggleMic),
    onMeetingCompanionToggleMic: (callback) =>
      subscribe(meetingCompanionEventChannels.toggleMic, () => true, () => callback()),
    onMeetingCompanionState: (callback) =>
      subscribe(
        meetingCompanionEventChannels.state,
        (raw) => meetingCompanionStateSchema.safeParse(raw).data,
        callback
      ),
    onMeetingCompanionLevel: (callback) =>
      subscribe(
        meetingCompanionEventChannels.level,
        (raw) => meetingCompanionLevelSchema.safeParse(raw).data,
        callback
      ),
  };
}
