// The recording companion: a small draggable always-on-top bubble shown while
// a meeting records and Gristmill is in the background. The control panel
// renderer (which owns the recording) pushes state and mic level to main; main
// owns the bubble window and relays both to it. No Electron/React imports here.
import { z } from "zod";

export const meetingCompanionChannels = {
  // control panel → main
  update: "meeting-companion-update",
  level: "meeting-companion-level",
  watchLevelDemand: "meeting-companion-watch-level-demand",
  // companion → main
  dragStart: "meeting-companion-drag-start",
  dragMove: "meeting-companion-drag-move",
  open: "meeting-companion-open",
  ready: "meeting-companion-ready",
  toggleMic: "meeting-companion-toggle-mic",
} as const;

export const meetingCompanionEventChannels = {
  state: "meeting-companion-state",
  level: "meeting-companion-level-changed",
  // main → control panel
  toggleMic: "meeting-companion-toggle-mic-requested",
  levelDemand: "meeting-companion-level-demand",
} as const;

export const meetingCompanionStateSchema = z.object({
  /** Recording (or paused) with the companion enabled. */
  active: z.boolean(),
  paused: z.boolean(),
  waitingForMic: z.boolean(),
  /** Manual or call/device mute: the microphone is not being recorded. */
  micMuted: z.boolean(),
  noteId: z.number().int().nullable(),
  folderId: z.number().int().nullable(),
  title: z.string(),
});

export type MeetingCompanionState = z.infer<typeof meetingCompanionStateSchema>;

export const meetingCompanionLevelSchema = z.number().min(0).max(1);

export const meetingCompanionLevelDemandSchema = z.boolean();

export const meetingCompanionPointSchema = z.tuple([z.number(), z.number()]);

export const INACTIVE_MEETING_COMPANION_STATE: MeetingCompanionState = {
  active: false,
  paused: false,
  waitingForMic: false,
  micMuted: false,
  noteId: null,
  folderId: null,
  title: "",
};

export interface MeetingCompanionApi {
  updateMeetingCompanion(state: MeetingCompanionState): void;
  sendMeetingCompanionLevel(level: number): void;
  meetingCompanionDragStart(screenX: number, screenY: number): void;
  meetingCompanionDragMove(screenX: number, screenY: number): void;
  openMeetingCompanionNote(): void;
  meetingCompanionReady(): void;
  meetingCompanionToggleMic(): void;
  onMeetingCompanionToggleMic(callback: () => void): () => void;
  onMeetingCompanionState(callback: (state: MeetingCompanionState) => void): () => void;
  onMeetingCompanionLevel(callback: (level: number) => void): () => void;
  onMeetingCompanionLevelDemand(callback: (needed: boolean) => void): () => void;
}
