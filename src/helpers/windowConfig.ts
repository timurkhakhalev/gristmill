import path from "path";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import type { WindowBounds, WindowSize } from "./onboardingWindowBounds.js";

// Kept only for legacy resize IPC responses while old preload bundles drain.
// No assistant or dictation window is created by the current renderer.
const ASSISTANT_PANEL_SIZE_LIMITS = {
  ratioWidth: 760,
  ratioHeight: 520,
  gutter: 24,
  minSurfaceWidth: 320,
  maxSurfaceWidth: 760,
  minSurfaceHeight: 120,
};

// All renderer windows share an app-owned persisted session. The explicit
// partition prevents Electron from ever reusing a profile created by the
// imported application when the user runs both apps side by side.
export const GRISTMILL_SESSION_PARTITION = "persist:gristmill";

export function resolveOverlayWindowType(_input?: {
  role?: string;
  platform?: string;
  linuxSession?: string;
}): "panel" {
  return "panel";
}

const OVERLAY_WINDOW_TYPES = { main: "panel", notification: "panel" } as const;

const ASSISTANT_WINDOW_SIZE = {
  width: ASSISTANT_PANEL_SIZE_LIMITS.ratioWidth + ASSISTANT_PANEL_SIZE_LIMITS.gutter,
  height: ASSISTANT_PANEL_SIZE_LIMITS.ratioHeight + ASSISTANT_PANEL_SIZE_LIMITS.gutter,
};

const DICTATION_ERROR_WINDOW_LIMITS = {
  width: ASSISTANT_WINDOW_SIZE.width,
  gutter: 24,
  minSurfaceHeight: 88,
};

export function fitAssistantWindowToWorkArea(
  requestedSize: WindowSize,
  workArea: WindowBounds
): WindowSize {
  const limits = ASSISTANT_PANEL_SIZE_LIMITS;
  const ratio = limits.ratioWidth / limits.ratioHeight;
  const availableSurfaceWidth = Math.max(1, workArea.width - limits.gutter);
  const availableSurfaceHeight = Math.max(1, workArea.height - limits.gutter);
  const maximumSurfaceWidth = Math.max(
    1,
    Math.min(
      limits.maxSurfaceWidth,
      availableSurfaceWidth,
      Math.floor(availableSurfaceHeight * ratio)
    )
  );
  const minimumSurfaceWidth = Math.min(limits.minSurfaceWidth, maximumSurfaceWidth);
  const requestedSurfaceWidth = Math.round(requestedSize.width - limits.gutter);
  const surfaceWidth = Math.max(
    minimumSurfaceWidth,
    Math.min(maximumSurfaceWidth, requestedSurfaceWidth)
  );
  const surfaceHeight = Math.round(surfaceWidth / ratio);

  return {
    width: surfaceWidth + limits.gutter,
    height: surfaceHeight + limits.gutter,
  };
}

// Shared shape of both content-height fits: clamp a renderer-measured surface
// height between the limits' floor and the caller's ceiling, then add the
// gutter frame back around the surface.
function fitContentWindowToWorkArea(
  limits: { minSurfaceHeight: number; gutter: number },
  requestedSurfaceHeight: unknown,
  { width, maximumSurfaceHeight }: { width: number; maximumSurfaceHeight: number }
): WindowSize {
  const minimumSurfaceHeight = Math.min(limits.minSurfaceHeight, maximumSurfaceHeight);
  const numericHeight = Number(requestedSurfaceHeight);
  const safeHeight = Number.isFinite(numericHeight)
    ? Math.round(numericHeight)
    : minimumSurfaceHeight;
  const surfaceHeight = Math.max(minimumSurfaceHeight, Math.min(safeHeight, maximumSurfaceHeight));

  return {
    width,
    height: surfaceHeight + limits.gutter,
  };
}

export function fitAssistantContentWindowToWorkArea(
  requestedSurfaceHeight: unknown,
  workArea: WindowBounds
): WindowSize {
  const limits = ASSISTANT_PANEL_SIZE_LIMITS;
  const maximumWindow = fitAssistantWindowToWorkArea(ASSISTANT_WINDOW_SIZE, workArea);
  return fitContentWindowToWorkArea(limits, requestedSurfaceHeight, {
    width: maximumWindow.width,
    maximumSurfaceHeight: maximumWindow.height - limits.gutter,
  });
}

export function fitDictationErrorContentWindowToWorkArea(
  requestedSurfaceHeight: unknown,
  workArea: WindowBounds
): WindowSize {
  const limits = DICTATION_ERROR_WINDOW_LIMITS;
  const fitted = fitContentWindowToWorkArea(limits, requestedSurfaceHeight, {
    width: fitAssistantWindowToWorkArea(ASSISTANT_WINDOW_SIZE, workArea).width,
    maximumSurfaceHeight: Math.max(1, workArea.height - limits.gutter),
  });
  return { ...fitted, height: Math.min(workArea.height, fitted.height) };
}

export function fitDictationErrorWindowToWorkArea(
  requestedSize: { height: unknown },
  workArea: WindowBounds
): WindowSize {
  const width = fitAssistantWindowToWorkArea(ASSISTANT_WINDOW_SIZE, workArea).width;
  const numericHeight = Number(requestedSize.height);
  const safeHeight = Number.isFinite(numericHeight) ? Math.round(numericHeight) : 1;

  return {
    width,
    height: Math.max(1, Math.min(safeHeight, workArea.height)),
  };
}

// The pill docks 12px from the window's bottom corner (voice-pill-position
// classes); the remaining area is click-through headroom so the hover
// tooltip and the Signal glow's halo render without clipping at the window
// bounds. Sized with dictation-panel.css's dock insets — change together.
// The box fits the compact pill + gap + hover cancel (134px) inside its 184px
// usable width, so the cancel control never clips. Those three numbers are
// VOICE_PILL_FOOTPRINT.recording and VOICE_PILL_CANCEL in
// src/helpers/voicePillPresentation.js — the renderer-side half of this
// contract, and the only place they are defined.
const PILL_WINDOW_SIZE = { width: 208, height: 120 };

export const WINDOW_SIZES = {
  // BASE and RECORDING are deliberately the same box. Resizing a transparent
  // always-on-top window paints one compositor frame of the stale texture
  // inside the new bounds before the renderer catches up — no resize mask can
  // cover it — so recording edges must never call setBounds. The keys stay
  // distinct for the size ladder's ranking; identical bounds make the native
  // resize a no-op.
  BASE: PILL_WINDOW_SIZE,
  RECORDING: PILL_WINDOW_SIZE,
  DICTATION_ERROR: { width: DICTATION_ERROR_WINDOW_LIMITS.width, height: 112 },
  DICTATION_ERROR_WITH_TRANSCRIPT: {
    width: DICTATION_ERROR_WINDOW_LIMITS.width,
    height: 168,
  },
  WITH_MENU: { width: 240, height: 280 },
  WITH_TOAST: { width: 400, height: 500 },
  EXPANDED: { width: 400, height: 500 },
  ASSISTANT: ASSISTANT_WINDOW_SIZE,
};

// Meeting/notification prompt payloads cross the window boundary as plain
// data. The engine builds detection prompts incrementally, and tests exercise
// partial payloads, so every field stays optional — `kind` only selects the
// auto-end size/timeout path.
export interface MeetingNotificationPrompt {
  kind?: "detection" | "auto-end" | "meet-context-lost";
  recordingId?: string;
  detectionId?: string;
  sessionId?: string;
  expiresAt?: number;
  reason?: string;
  source?: string | null;
  key?: string;
  variant?: string;
  joinUrl?: string | null;
  event?: unknown;
}

/**
 * Resolve the horizontal voice-animation origin from where the native overlay
 * actually sits. The saved preference is only a fallback for an exact center
 * or unavailable geometry; dragging the pill must be able to override it.
 */
export function resolveHorizontalWindowDirection(
  bounds?: Partial<WindowBounds> | null,
  display?: { workArea?: WindowBounds | null; bounds?: WindowBounds | null } | null,
  preferredPosition: string = "bottom-right"
): "left" | "right" {
  if (preferredPosition === "center") return "right";

  const workArea = display?.workArea || display?.bounds;
  const windowCenter = Number(bounds?.x) + Number(bounds?.width) / 2;
  const displayCenter = Number(workArea?.x) + Number(workArea?.width) / 2;
  if (!Number.isFinite(windowCenter) || !Number.isFinite(displayCenter)) {
    return preferredPosition === "bottom-left" ? "left" : "right";
  }
  if (windowCenter === displayCenter) {
    return preferredPosition === "bottom-left" ? "left" : "right";
  }
  return windowCenter < displayCenter ? "left" : "right";
}

// Electron ignores the two extra keys (visibleOnAllWorkspaces is window
// methods, acceptsFirstMouse predates the correct acceptFirstMouse spelling);
// they stay so the shipped configs remain byte-identical.
type LegacyWindowConfig = BrowserWindowConstructorOptions & {
  acceptsFirstMouse?: boolean;
  visibleOnAllWorkspaces?: boolean;
  fullScreenable?: boolean;
};

// Legacy hidden renderer configuration. The visible application is the control
// panel; this window remains inert for an upgrade-safe main-process cutover.
export const MAIN_WINDOW_CONFIG: LegacyWindowConfig = {
  width: WINDOW_SIZES.BASE.width,
  height: WINDOW_SIZES.BASE.height,
  title: "Gristmill",
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    partition: GRISTMILL_SESSION_PARTITION,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    // The hotkey shows this window from hidden right as the entrance animation
    // and resize mask run; a throttled renderer stutters them for seconds.
    backgroundThrottling: false,
  },
  frame: false,
  alwaysOnTop: true,
  resizable: false,
  transparent: true,
  show: false,
  skipTaskbar: true,
  focusable: false,
  visibleOnAllWorkspaces: true,
  fullScreenable: false,
  hasShadow: false,
  acceptsFirstMouse: true,
  type: OVERLAY_WINDOW_TYPES.main,
};

// The expanded flow deliberately uses a denser frame than the main control
// panel. Its typography, cards and spacing are sized for this 1000x740 canvas;
// clampedBounds still handles displays whose work area is smaller.
export const ONBOARDING_WINDOW_SIZES = {
  COMPACT: { width: 480, height: 624 },
  EXPANDED: { width: 1000, height: 740 },
};

// Floor for the normal control panel. Compact onboarding may go smaller while
// that mode is active; restore puts this floor back.
export const CONTROL_PANEL_MIN_SIZE = { width: 540, height: 640 };

// Control panel window configuration
export const CONTROL_PANEL_CONFIG: LegacyWindowConfig = {
  width: 1200,
  height: 800,
  minWidth: CONTROL_PANEL_MIN_SIZE.width,
  minHeight: CONTROL_PANEL_MIN_SIZE.height,
  // Fully transparent so nothing paints into the compact onboarding frame's
  // rounded corners.
  backgroundColor: "#00000000",
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    partition: GRISTMILL_SESSION_PARTITION,
    nodeIntegration: false,
    contextIsolation: true,
    // sandbox: false is required because the preload script bridges IPC
    // between the renderer and main process.
    sandbox: false,
    // webSecurity: false disables same-origin policy. Required because in
    // production the renderer loads from a file:// origin but makes
    // cross-origin fetch calls to direct provider APIs
    // directly from the browser. These would be blocked by CORS otherwise.
    webSecurity: false,
    spellcheck: false,
    backgroundThrottling: false,
  },
  title: "Control Panel",
  resizable: true,
  show: false,
  frame: false,
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 20, y: 20 },
  // macOS only: transparent so a renderer that insets or rounds itself shows
  // the desktop rather than a square page backing bleeding out behind it. Safe
  // for the other control panel screens because each paints its own opaque
  // background (ControlPanel's root is `bg-background`); only the compact
  transparent: true,
  minimizable: true,
  maximizable: true,
  closable: true,
  fullscreenable: true,
  skipTaskbar: false,
  alwaysOnTop: false,
  visibleOnAllWorkspaces: false,
  type: "normal",
};

const NOTIFICATION_WINDOW_WIDTH = 420;
const NOTIFICATION_WINDOW_HEIGHT = 80;

export const NOTIFICATION_WINDOW_CONFIG: LegacyWindowConfig = {
  width: NOTIFICATION_WINDOW_WIDTH,
  height: NOTIFICATION_WINDOW_HEIGHT,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  focusable: false,
  hasShadow: false,
  show: false,
  acceptFirstMouse: true,
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    partition: GRISTMILL_SESSION_PARTITION,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
  visibleOnAllWorkspaces: true,
  type: OVERLAY_WINDOW_TYPES.notification,
};

export const AUTO_END_NOTIFICATION_WINDOW_SIZE = {
  width: 480,
  height: 128,
};

export function getMeetingNotificationWindowSize(
  promptData?: MeetingNotificationPrompt | null
): WindowSize {
  if (promptData?.kind === "auto-end") {
    return AUTO_END_NOTIFICATION_WINDOW_SIZE;
  }
  return {
    width: NOTIFICATION_WINDOW_WIDTH,
    height: NOTIFICATION_WINDOW_HEIGHT,
  };
}

// Structural slice of Electron's Display the position helpers read. Tests
// drive them with partial display fakes, and the Electron object always
// satisfies this shape.
export interface DisplayGeometry {
  workArea?: WindowBounds;
  bounds?: WindowBounds;
}

type AlwaysOnTopLevel =
  | "floating"
  | "torn-off-menu"
  | "modal-panel"
  | "main-menu"
  | "status"
  | "pop-up-menu"
  | "screen-saver";

export class WindowPositionUtil {
  static getMainWindowPosition(
    display: DisplayGeometry,
    customSize: WindowSize | null = null,
    position: string = "bottom-right"
  ): WindowBounds {
    const { width, height } = customSize || WINDOW_SIZES.BASE;
    const MARGIN = 4;
    const workArea = (display.workArea || display.bounds) as WindowBounds;

    let x: number;
    let y: number;
    if (position === "bottom-left") {
      x = workArea.x + MARGIN;
      y = workArea.y + workArea.height - height - MARGIN;
    } else if (position === "center") {
      x = Math.round(workArea.x + (workArea.width - width) / 2);
      y = workArea.y + workArea.height - height - MARGIN;
    } else {
      // bottom-right (default)
      x = workArea.x + workArea.width - width - MARGIN;
      y = workArea.y + workArea.height - height - MARGIN;
    }

    // Clamped to the display's own work area, never to zero: a monitor placed
    // above or left of the primary one has a negative origin, so flooring at zero
    // lands the window on a coordinate that display doesn't cover.
    return {
      ...WindowPositionUtil.clampToWorkArea({ x, y, width, height }, display),
      width,
      height,
    };
  }

  // Keeps a window's whole frame inside one display's work area. Displays of
  // different sizes leave dead space beside the smaller one, and a window parked
  // there is invisible even though the window server still reports it on screen.
  static clampToWorkArea(bounds: WindowBounds, display: DisplayGeometry): { x: number; y: number } {
    const workArea = (display.workArea || display.bounds) as WindowBounds;
    return {
      x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width)),
      y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height)),
    };
  }

  static getNotificationPosition(
    display: DisplayGeometry,
    customSize: WindowSize | null = null
  ): WindowBounds {
    const { width, height } =
      customSize || { width: NOTIFICATION_WINDOW_WIDTH, height: NOTIFICATION_WINDOW_HEIGHT };
    const MARGIN = 16;
    const workArea = (display.workArea || display.bounds) as WindowBounds;
    // Same negative-origin trap as getMainWindowPosition: clamp to the display,
    // not to zero, or a monitor above the primary one puts the prompt nowhere.
    const bounds = {
      x: workArea.x + workArea.width - width - MARGIN,
      y: workArea.y + MARGIN,
      width,
      height,
    };
    return { ...WindowPositionUtil.clampToWorkArea(bounds, display), width, height };
  }

  static setupAlwaysOnTop(
    window: BrowserWindow,
    { level = "floating" }: { level?: AlwaysOnTopLevel } = {}
  ): void {
    window.setAlwaysOnTop(true, level, 1);
    if (!window.isVisibleOnAllWorkspaces()) {
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }
    if (window.isFullScreenable()) {
      window.setFullScreenable(false);
    }
    if (window.isVisible()) {
      window.setAlwaysOnTop(true, level, 1);
    }
  }
}
