// Electron-free placement and visibility rules for the recording companion
// bubble (meetingCompanionWindow.ts), unit-tested in
// test/helpers/meetingCompanionPolicy.test.js.

// A vertical pill: app mark on top, live voice bars below. The window adds a
// few px around the pill so its shadow isn't clipped.
export const MEETING_COMPANION_SIZE: Size = { width: 42, height: 76 };
const EDGE_MARGIN = 12;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
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
export function clampToWorkArea(point: Point, workArea: WorkArea, size: Size): Point {
  return {
    x: Math.round(
      Math.min(Math.max(point.x, workArea.x), workArea.x + workArea.width - size.width)
    ),
    y: Math.round(
      Math.min(Math.max(point.y, workArea.y), workArea.y + workArea.height - size.height)
    ),
  };
}

export function defaultCompanionPosition(workArea: WorkArea, size: Size): Point {
  return {
    x: workArea.x + workArea.width - size.width - EDGE_MARGIN,
    y: workArea.y + Math.round(workArea.height * 0.6),
  };
}
