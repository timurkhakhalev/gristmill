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
import { subscribeValidated, type IpcRendererLike } from "./ipcTransport.js";

export function createMeetingCompanionBridge(ipcRenderer: IpcRendererLike): MeetingCompanionApi {
  const subscribe = <T>(
    channel: string,
    parse: (raw: unknown) => T | undefined,
    callback: (value: T) => void
  ): (() => void) => subscribeValidated(ipcRenderer, channel, parse, callback);

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
      subscribe(
        meetingCompanionEventChannels.toggleMic,
        () => true,
        () => callback()
      ),
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
