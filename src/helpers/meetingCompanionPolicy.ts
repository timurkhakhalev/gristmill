// Electron-free placement and visibility rules for the recording companion
// bubble (meetingCompanionWindow.ts), unit-tested in
// test/helpers/meetingCompanionPolicy.test.js.

export const MEETING_COMPANION_SIZE = 64;
const EDGE_MARGIN = 12;

export interface Point {
  x: number;
  y: number;
}

interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bubble shows only while recording and the control panel is not the focused window. */
export function shouldShowMeetingCompanion(active: boolean, controlPanelFocused: boolean): boolean {
  return active && !controlPanelFocused;
}

/** Keeps the whole bubble on a display's work area. */
export function clampToWorkArea(point: Point, workArea: WorkArea, size: number): Point {
  return {
    x: Math.round(Math.min(Math.max(point.x, workArea.x), workArea.x + workArea.width - size)),
    y: Math.round(Math.min(Math.max(point.y, workArea.y), workArea.y + workArea.height - size)),
  };
}

export function defaultCompanionPosition(workArea: WorkArea, size: number): Point {
  return {
    x: workArea.x + workArea.width - size - EDGE_MARGIN,
    y: workArea.y + Math.round(workArea.height * 0.6),
  };
}
