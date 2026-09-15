import { EventEmitter } from "events";
import debugLogger from "./debugLogger.js";
import { processListCache } from "./processListCache.js";

const POLL_INTERVAL_MS = 30 * 1000;

const BUNDLE_ID_MAP: Record<string, MeetingProcessKey> = {
  "us.zoom.xos": "zoom",
  "com.microsoft.teams": "teams",
  "com.microsoft.teams2": "teams",
  "com.cisco.webexmeetingsapp": "webex",
  "com.apple.FaceTime": "facetime",
};

const BUNDLE_APP_NAMES: Record<string, string> = {
  zoom: "Zoom",
  teams: "Microsoft Teams",
  webex: "Webex",
  facetime: "FaceTime",
};

type MeetingProcessKey = "zoom" | "teams" | "webex" | "facetime";

interface MeetingAppEntry {
  processKey: MeetingProcessKey;
  appName: string;
  imageName: string;
}

const MEETING_APPS: Record<string, MeetingAppEntry[]> = {
  win32: [
    { processKey: "zoom", appName: "Zoom", imageName: "cpthost.exe" },
    { processKey: "teams", appName: "Microsoft Teams", imageName: "ms-teams_modulehost.exe" },
    { processKey: "webex", appName: "Webex", imageName: "webexmeetingsapp.exe" },
  ],
  linux: [
    { processKey: "zoom", appName: "Zoom", imageName: "zoom" },
    { processKey: "teams", appName: "Microsoft Teams", imageName: "teams" },
  ],
};

interface DetectedProcessEntry {
  detectedAt: number;
}

export interface DetectedMeetingProcess {
  processKey: string;
  appName: string;
  detectedAt: number;
}

export interface MeetingProcessDetectedEvent {
  processKey: string;
  appName: string;
  detectedAt: number;
}

export interface MeetingProcessEndedEvent {
  processKey: string;
  appName: string;
}

interface WorkspaceSubscription {
  subscribeWorkspaceNotification?(
    event: string,
    callback: (_event: unknown, userInfo: { NSApplicationBundleIdentifier?: string } | null) => void
  ): number;
  unsubscribeWorkspaceNotification?(id: number): void;
}

export class MeetingProcessDetector extends EventEmitter {
  private pollInterval: NodeJS.Timeout | null = null;
  private detectedProcesses = new Map<string, DetectedProcessEntry>();
  private dismissedProcesses = new Set<string>();
  private _polling = false;
  private _subscriptionIds: number[] = [];

  start(): void {
    if (this.pollInterval || this._subscriptionIds.length > 0) return;

    if (process.platform === "darwin") {
      this._startDarwin();
    } else {
      const apps = MEETING_APPS[process.platform] || [];
      debugLogger.info(
        "Process detector started",
        {
          platform: process.platform,
          appsMonitored: apps.map((a) => a.appName),
          intervalMs: POLL_INTERVAL_MS,
        },
        "meeting"
      );
      void this._poll();
      this.pollInterval = setInterval(() => void this._poll(), POLL_INTERVAL_MS);
    }
  }

  _startDarwin(): void {
    let systemPreferences: WorkspaceSubscription | undefined;
    try {
      systemPreferences = require("electron").systemPreferences;
    } catch {
      debugLogger.warn("systemPreferences unavailable, falling back to polling", {}, "meeting");
      this._startPollingFallback();
      return;
    }

    if (!systemPreferences?.subscribeWorkspaceNotification) {
      debugLogger.warn(
        "subscribeWorkspaceNotification unavailable, falling back to polling",
        {},
        "meeting"
      );
      this._startPollingFallback();
      return;
    }

    const processKeyFrom = (
      userInfo: { NSApplicationBundleIdentifier?: string } | null | undefined
    ): MeetingProcessKey | null => {
      const bundleId = userInfo?.NSApplicationBundleIdentifier;
      return bundleId ? BUNDLE_ID_MAP[bundleId] ?? null : null;
    };

    const launchId = systemPreferences.subscribeWorkspaceNotification(
      "NSWorkspaceDidLaunchApplicationNotification",
      (_event, userInfo) => {
        const processKey = processKeyFrom(userInfo);
        if (processKey) {
          const appName = BUNDLE_APP_NAMES[processKey] || processKey;
          debugLogger.debug(
            "Workspace app launched",
            { bundleId: userInfo?.NSApplicationBundleIdentifier, processKey },
            "meeting"
          );
          this._updateDetection(processKey, appName, true);
        }
      }
    );

    const terminateId = systemPreferences.subscribeWorkspaceNotification(
      "NSWorkspaceDidTerminateApplicationNotification",
      (_event, userInfo) => {
        const processKey = processKeyFrom(userInfo);
        if (processKey) {
          const appName = BUNDLE_APP_NAMES[processKey] || processKey;
          debugLogger.debug(
            "Workspace app terminated",
            { bundleId: userInfo?.NSApplicationBundleIdentifier, processKey },
            "meeting"
          );
          this._updateDetection(processKey, appName, false);
        }
      }
    );

    this._subscriptionIds.push(launchId, terminateId);

    debugLogger.info(
      "Process detector started",
      {
        platform: "darwin",
        mode: "NSWorkspace",
        bundleIds: Object.keys(BUNDLE_ID_MAP),
      },
      "meeting"
    );

    void this._initialScanDarwin();
  }

  async _initialScanDarwin(): Promise<void> {
    try {
      const processList = await processListCache.getProcessList();
      const darwinProcessNames = [
        { match: "zoom.us", processKey: "zoom" as MeetingProcessKey },
        { match: "microsoft teams", processKey: "teams" as MeetingProcessKey },
        { match: "webex", processKey: "webex" as MeetingProcessKey },
        { match: "facetime", processKey: "facetime" as MeetingProcessKey },
      ];
      for (const { match, processKey } of darwinProcessNames) {
        if (processList.some((p) => p.includes(match))) {
          const appName = BUNDLE_APP_NAMES[processKey] || processKey;
          debugLogger.info("Initial scan: already running", { processKey, appName }, "meeting");
          this._updateDetection(processKey, appName, true);
        }
      }
    } catch (err) {
      debugLogger.warn(
        "Initial scan failed",
        { error: err instanceof Error ? err.message : String(err) },
        "meeting"
      );
    }
  }

  _startPollingFallback(): void {
    const apps = MEETING_APPS.linux || [];
    debugLogger.info(
      "Process detector started (polling fallback)",
      {
        platform: process.platform,
        appsMonitored: apps.map((a) => a.appName),
        intervalMs: POLL_INTERVAL_MS,
      },
      "meeting"
    );
    void this._poll();
    this.pollInterval = setInterval(() => void this._poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this._subscriptionIds.length > 0) {
      try {
        const { systemPreferences } = require("electron") as {
          systemPreferences?: WorkspaceSubscription;
        };
        for (const id of this._subscriptionIds) {
          systemPreferences?.unsubscribeWorkspaceNotification?.(id);
        }
      } catch {
        // electron may not be available during cleanup
      }
      this._subscriptionIds = [];
    }

    this.detectedProcesses.clear();
    this.dismissedProcesses.clear();
    debugLogger.info("Stopped meeting process detector", {}, "meeting");
  }

  dismiss(processKey: string): void {
    this.dismissedProcesses.add(processKey);
    debugLogger.info("Process detection dismissed", { processKey }, "meeting");
  }

  getDetectedProcesses(): DetectedMeetingProcess[] {
    return Array.from(this.detectedProcesses.entries()).map(([processKey, { detectedAt }]) => ({
      processKey,
      appName: this._getAppName(processKey),
      detectedAt,
    }));
  }

  _getAppName(processKey: string): string {
    if (process.platform === "darwin") {
      return BUNDLE_APP_NAMES[processKey] || processKey;
    }
    const apps = MEETING_APPS[process.platform] || [];
    const entry = apps.find((a) => a.processKey === processKey);
    return entry ? entry.appName : processKey;
  }

  async _poll(): Promise<void> {
    if (this._polling) return;
    this._polling = true;
    try {
      const apps = MEETING_APPS[process.platform] || MEETING_APPS.linux || [];
      const processList = await processListCache.getProcessList();

      for (const { processKey, appName, imageName } of apps) {
        const isRunning = processList.includes(imageName);
        this._updateDetection(processKey, appName, isRunning);
      }
    } catch (err) {
      debugLogger.warn(
        "Poll error",
        { error: err instanceof Error ? err.message : String(err) },
        "meeting"
      );
    } finally {
      this._polling = false;
    }
  }

  _updateDetection(processKey: string, appName: string, isRunning: boolean): void {
    if (isRunning) {
      if (!this.detectedProcesses.has(processKey) && !this.dismissedProcesses.has(processKey)) {
        const detectedAt = Date.now();
        this.detectedProcesses.set(processKey, { detectedAt });
        debugLogger.info("Meeting process detected", { processKey, appName }, "meeting");
        this.emit("meeting-process-detected", { processKey, appName, detectedAt });
      }
    } else if (this.detectedProcesses.has(processKey)) {
      this.detectedProcesses.delete(processKey);
      this.dismissedProcesses.delete(processKey);
      debugLogger.info("Meeting process ended", { processKey, appName }, "meeting");
      this.emit("meeting-process-ended", { processKey, appName });
    }
  }
}

module.exports = MeetingProcessDetector;
module.exports.MeetingProcessDetector = MeetingProcessDetector;
