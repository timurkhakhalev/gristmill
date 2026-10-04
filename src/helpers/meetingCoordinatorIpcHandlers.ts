import { computeChunkStats } from "../utils/audioUtils.js";
import { MeetingClockSync, type MeetingClockProbeReply } from "./meetingClockSync.js";
import { MeetSpeakerEvidence } from "./meetSpeakerEvidence.js";
import { CompanionCoordinator } from "./companionCoordinator.js";
import { CompanionServer } from "./companionServer.js";
import { isDevelopmentChannel } from "./appChannel.js";
import { companionSelectionSchema, companionRecordingScopeSchema } from "../contracts/companion.js";
// The main-process meeting coordinator owns capture preparation, recording
// start/stop, durable raw audio writes, source availability, detection and
// auto-end IPC, recording locks, mic warm hold, notifications, and speaker
// management. Meeting processing starts after capture and is not run here.
import {
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import debugLogger from "./debugLogger.js";
import {
  createMeetingSystemAudioWatchdog,
  type MeetingSystemAudioWatchdog,
} from "./meetingSystemAudioWatchdog.js";
import {
  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
} from "./meetingMicGate.js";
import { ZoomSpeakerCollector, type MeetingPlatformEvidenceDatabase } from "./zoomSpeakerCollector.js";
import { createMeetingAudioTimeline } from "./meetingAudioTimeline.js";
import { MeetingCaptureSession, type MeetingCaptureEpochStorage } from "./meetingCaptureSession.js";
import { meetingRecordingConfigInputSchema } from "../contracts/meetingRecording.js";
import {
  meetingCapturePacketSchema,
  meetingCaptureStopRequestSchema,
  meetingMicIntentRequestSchema,
  meetingClockProbeRequestSchema,
  meetingOptionsSchema,
} from "../contracts/meetingCoordinator.js";
import { createMeetingTranscriptionLifecycle } from "./meetingTranscriptionLifecycle.js";
import { registerMeetingAutoEndLifecycleHandlers, type MeetingAutoEndEngineLike } from "./meetingAutoEndLifecycle.js";
import type { AudioTapManager } from "./audioTapManager.js";
import type { MeetingDetectionEngine } from "./meetingDetectionEngine.js";
import { broadcastToWindows } from "./windowBroadcast.js";
import {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
  noteExpectedSpeakerCountOrNull,
  resolveOneOnOneOtherParticipant,
  type MeetingSpeakerRosterDatabase,
  type MeetingSessionSpeakerConfig,
  type MeetingSpeakerRosterNote,
} from "./meetingSpeakerRoster.js";

const MEETING_SYSTEM_AUDIO_TICK_MS = 2000;
// Level meters (in-app pill, companion) only need ~20 updates a second.
const MEETING_SYSTEM_AUDIO_LEVEL_INTERVAL_MS = 50;

export type MeetingAudioSource = "mic" | "system";

export interface CoordinatorWindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload?: unknown): void };
}

export interface MeetingCoordinatorDeps {
  companionProfilePath?: string;
  companionEnabled?: boolean;
  showCompanionReminder?(scope: MeetingRecordingScope): void;
  dismissCompanionReminder?(scope: MeetingRecordingScope, sender?: WebContents): boolean;
  databaseManager: MeetingSpeakerRosterDatabase & import("./meetingCaptureSession.js").MeetingCaptureDatabase & MeetingPlatformEvidenceDatabase;
  meetingRecordingStorage: MeetingCaptureEpochStorage;
  cancelInitialProcessingRun?: (runId: string) => boolean;
  meetingDetectionEngine: (Pick<MeetingDetectionEngine,
    "setUserRecording" | "beginRecordingSession" | "endRecordingSession" |
    "recordMeetingAudioChunk" | "setRecordingSystemAudioAvailable" | "setMicWarmHold" |
    "getPreferences" | "setPreferences" | "handleNotificationResponse" |
    "joinCalendarMeeting" | "findCalendarEventNote" | "createCalendarEventNote"> & MeetingAutoEndEngineLike) | null;
  suppressPlatformAutoEnd?(sessionId: string): void;
  preparePlatformLeave?(sessionId: string): boolean;
  audioTapManager: Pick<AudioTapManager, "isSupported" | "start" | "stop" | "probeClock" | "getClockOrigin"> | null;
  // Narrow window-manager surface (notification window + note navigation +
  // owning window), owned by the composition root.
  getControlPanelWindow?(): CoordinatorWindowLike | null;
  getMeetingNotificationData?(): unknown;
  consumePendingMeetingNoteNavigation?(): unknown;
  showNotificationWindow?(sender: WebContents): void;
  setMeetingCaptureState?(active: boolean): void;
  onCaptureStarted?(noteId: number): void;
  onCaptureStopped?(): void;
}

interface MeetingSystemAudioPlan {
  mode: "native" | "unsupported";
  strategy: "native" | "unsupported";
}

// Method syntax on purpose: method members stay parameter-bivariant, so test
// fixtures may declare wider (unknown-event) listeners than Electron's own.
// The rest args are any[] for the same reason Electron's own IpcMain types are.
export type IpcMainLike = {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): unknown;
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): unknown;
};

export interface MeetingRecordingScope { recordingId: string; sessionId: string }
export interface MeetingSafeStopOptions {
  expected: MeetingRecordingScope;
  reason: "quit" | "delete-audio" | "platform-leave" | "context-reminder";
  suppressProcessing?: boolean;
}

export interface MeetingCoordinatorRuntime {
  isRecording(): boolean;
  shutdown(): Promise<void>;
  startCompanion(): Promise<void>;
  disposeCompanion(): Promise<void>;
  setCompanionEnabled(enabled: boolean): void;
  currentRecordingScope(): MeetingRecordingScope | null;
  requestSafeStop(options: MeetingSafeStopOptions): Promise<{ success: boolean; captureState?: "ready" | "incomplete" }>;
  // Recording start links the live session to its note; the notes vertical's
  // roster refresh only applies while that link is current.
  linkRecordingSessionToNote(noteId: number | null): void;
  // Notes vertical: roster-driven refresh of the live session speaker cap.
  refreshMeetingSpeakerConfigFromNote(
    noteId: number | null,
    note: MeetingSpeakerRosterNote | null | undefined
  ): void;
  // Speaker vertical: 1-on-1 auto labeling needs the same participant rule.
  resolveOneOnOneOtherParticipant(
    participantsJson: string | null | undefined
  ): { displayName: string; email: string | null } | null;
}

interface MeetingStartFailure {
  success: false;
  error: string;
  code?: string;
  messageKey?: string;
  [key: string]: unknown;
}

export function registerMeetingCoordinatorHandlers(
  ipcMain: IpcMainLike,
  deps: MeetingCoordinatorDeps
): MeetingCoordinatorRuntime {
  const {
    databaseManager,
    meetingDetectionEngine,
    audioTapManager,
  } = deps;

  let meetingTranscriptionStartInProgress = false;
  let activeMeetingSpeakerConfig: MeetingSessionSpeakerConfig | null = null;
  let activeRecordingPipeline: string | null = null;
  let activeMeetingNoteId: number | null = null;
  let activeCaptureSession: MeetingCaptureSession | null = null;
  let platformCollector: ZoomSpeakerCollector | null = null;
  let captureDraining = false;
  let platformMuted = false;
  let pausedRecording: { recordingId: string; manualMuted: boolean } | null = null;
  let lastStoppedBinding: { sessionId: string; candidate: import("../contracts/companion.js").CompanionCandidateKey | null } | null = null;
  let activeCaptureSessionId: string | null = null;
  let activeCaptureOwner: WebContents | null = null;
  let safeStopScope: MeetingRecordingScope | null = null;
  let safeStopPromise: Promise<{ success: boolean; captureState?: "ready" | "incomplete" }> | null = null;
  let resolveSafeStop: ((result: { success: boolean; captureState?: "ready" | "incomplete" }) => void) | null = null;
  const micHoldSenders = new Map<number, () => void>();
  const browserClocks = new Map<string, { sync: MeetingClockSync; generation: string; replies: Map<string, MeetingClockProbeReply> }>();
  const browserClockKey = (connectionId: string, ref: import("../contracts/companion.js").CompanionCallRef) => `${connectionId}/${ref.platform}/${ref.documentId}/${ref.callId}`;
  let meetCoverage: { reads: number; samples: number; reason: string | null } | null = null;
  const meetEvidence = new MeetSpeakerEvidence((observation) => {
    databaseManager.saveMeetingPlatformObservation(observation);
    if (meetCoverage) meetCoverage.samples++;
  });
  const companion = new CompanionCoordinator({
    now: Date.now,
    currentScope: () => currentRecordingScope(),
    canBind: () => !captureDraining && !safeStopPromise,
    suppressAutoEnd: (scope) => {
      deps.suppressPlatformAutoEnd?.(scope.sessionId);
      meetCoverage ??= { reads: 0, samples: 0, reason: null };
      platformCollector?.invalidate("meet-bound");
    },
    setPlatformMuted: (scope, muted) => {
      platformMuted = muted;
      if (activeCaptureOwner && !activeCaptureOwner.isDestroyed()) activeCaptureOwner.send("meet-platform-mute", { ...scope, muted });
    },
    leave: (binding) => {
      deps.preparePlatformLeave?.(binding.sessionId);
      void requestSafeStop({ expected: binding, reason: "platform-leave" });
    },
    remind: (scope) => deps.showCompanionReminder?.(scope),
    observe: (binding, context) => {
      if (meetCoverage) meetCoverage.reads++;
      const clock = browserClocks.get(browserClockKey(binding.connectionId, binding.ref));
      try { meetEvidence.observe(binding, context, clock?.sync.mappingAt(context.sourceNs, context.sourceNs) ?? null); }
      catch { meetEvidence.reset(); if (meetCoverage) meetCoverage.reason = "metadata-write-failed"; }
    },
    changed: (status) => {
      if (meetCoverage && status.binding && status.contextUnavailableSince !== null) meetCoverage.reason ??= "meet-context-unavailable";
      if (status.binding && status.contextUnavailableSince === null) deps.dismissCompanionReminder?.(status.binding);
      broadcastToWindows("meet-companion-status", status);
      companionServer?.broadcastSnapshot();
    },
  });
  const companionServer = deps.companionProfilePath ? new CompanionServer({
    channel: isDevelopmentChannel() ? "development" : "production",
    profilePath: deps.companionProfilePath,
    snapshot: () => ({ recordingState: activeCaptureSession ? "recording" : pausedRecording ? "paused" : "idle",
      recordingId: activeCaptureSession?.recordingId ?? pausedRecording?.recordingId ?? null, binding: companion.status().binding?.ref ?? null,
      contextState: !companion.status().enabled ? "disabled" : !companion.status().binding ? "unbound" : companion.status().contextUnavailableSince !== null ? "unavailable" : "recognized",
      manualMuted: activeCaptureSession?.getMicIntent().manualMuted ?? pausedRecording?.manualMuted ?? false, platformMuted }),
    onMessage: (connection, message, send) => {
      if (message.type === "context") { companion.receive({ connectionId: connection.id, ref: message.ref }, message.context); return; }
      const binding = companion.status().binding;
      if (!companion.status().enabled || !binding || binding.connectionId !== connection.id || binding.ref.documentId !== message.ref.documentId || binding.ref.platform !== message.ref.platform || binding.ref.callId !== message.ref.callId) return;
      if (message.type === "manual-mute") {
        const scope = currentRecordingScope();
        if (!scope || scope.recordingId !== message.recordingId || captureDraining || safeStopPromise) return;
        if (activeCaptureOwner && !activeCaptureOwner.isDestroyed()) activeCaptureOwner.send("meet-manual-mute", { ...scope, muted: message.muted });
        return;
      }
      const key = browserClockKey(connection.id, message.ref);
      if (message.type === "clock-confirm") {
        const clock = browserClocks.get(key);
        const reply = clock?.replies.get(message.nonce);
        clock?.replies.delete(message.nonce);
        if (clock && reply) clock.sync.accept(reply, message.sourceReceiveNs);
        return;
      }
      const origin = audioTapManager?.getClockOrigin();
      if (!audioTapManager || !origin || !activeCaptureSession || captureDraining) {
        send({ version: 1, type: "unavailable", reason: "clock-unavailable" }); return;
      }
      let clock = browserClocks.get(key);
      if (!clock || clock.generation !== origin.helperGeneration) {
        if (browserClocks.size >= 128) browserClocks.delete(browserClocks.keys().next().value!);
        const sync = new MeetingClockSync(); sync.reset(origin.helperGeneration);
        clock = { sync, generation: origin.helperGeneration, replies: new Map() }; browserClocks.set(key, clock);
      }
      try { clock.sync.createProbe(message.sourceSendNs, message.nonce); } catch { return; }
      const pendingClock = clock;
      void audioTapManager.probeClock(message.nonce).then((reply) => {
        if (browserClocks.get(key) !== pendingClock) return;
        if (pendingClock.replies.size >= 8) pendingClock.replies.delete(pendingClock.replies.keys().next().value!);
        pendingClock.replies.set(message.nonce, reply);
        send({ version: 1, type: "clock-reply", nonce: reply.nonce, helperReceiveNs: reply.helperReceiveNs,
          helperSendNs: reply.helperSendNs, helperGeneration: reply.helperGeneration, helperFrame: reply.helperFrame });
      }).catch(() => {});
    },
    onDisconnect: (connection) => {
      for (const key of browserClocks.keys()) if (key.startsWith(`${connection.id}/`)) browserClocks.delete(key);
      companion.disconnect(connection.id); meetEvidence.reset();
    },
  }) : null;
  if (deps.companionEnabled === false) companion.setEnabled(false);
  let companionStarted: Promise<void> | null = null;
  let companionTicker: NodeJS.Timeout | null = null;
  ipcMain.handle("meet-recording-finish-paused", (event, recordingId: unknown) => {
    if (event.sender !== deps.getControlPanelWindow?.()?.webContents || recordingId !== pausedRecording?.recordingId) return { success: false };
    pausedRecording = null; companionServer?.broadcastSnapshot(); return { success: true };
  });
  ipcMain.handle("meet-context-reminder-respond", async (event, request: unknown) => {
    if (!request || typeof request !== "object" || !("action" in request) || (request.action !== "stop" && request.action !== "dismiss")) return { success: false };
    const { action, ...scope } = request;
    const parsed = companionRecordingScopeSchema.safeParse(scope);
    if (!parsed.success || !deps.dismissCompanionReminder?.(parsed.data, event.sender)) return { success: false };
    if (action === "dismiss") return { success: true };
    return requestSafeStop({ expected: parsed.data, reason: "context-reminder" });
  });
  ipcMain.handle("meeting-auto-end-claim", (event, sessionId: unknown) => {
    if (event.sender !== activeCaptureOwner || sessionId !== activeCaptureSessionId || !activeCaptureSession || companion.status().binding || captureDraining || safeStopPromise) return { success: false };
    captureDraining = true;
    return { success: true };
  });
  ipcMain.handle("meet-companion-status", () => companion.status());
  ipcMain.handle("meet-companion-select", (event, request: unknown) => {
    const parsed = companionSelectionSchema.safeParse(request);
    return { success: parsed.success && event.sender === activeCaptureOwner && companion.confirm(parsed.data.expected, parsed.data.candidate) };
  });

  const rosterDeps = {
    databaseManager,
  };

  function linkRecordingSessionToNote(noteId: number | null): void {
    activeMeetingNoteId = noteId;
  }

  function releaseCaptureOwnership(capture: MeetingCaptureSession, expectedSessionId: string): void {
    if (activeCaptureSession !== capture || activeCaptureSessionId !== expectedSessionId) return;
    activeCaptureSession = null;
    activeCaptureSessionId = null;
    activeCaptureOwner = null;
    platformMuted = false;
    linkRecordingSessionToNote(null);
    deps.onCaptureStopped?.();
    companionServer?.broadcastSnapshot();
    deps.setMeetingCaptureState?.(false);
  }

  const getMeetingSystemAudioCapabilityMode = (): "native" | "unsupported" => {
    if (audioTapManager?.isSupported()) return "native";
    return "unsupported";
  };

  const getMeetingSystemAudioMode = () => getMeetingSystemAudioCapabilityMode();

  const getMeetingSystemAudioPlan = async (): Promise<MeetingSystemAudioPlan> => {
    const mode = getMeetingSystemAudioMode();
    if (mode === "unsupported") {
      return { mode, strategy: "unsupported" };
    }

    return { mode, strategy: "native" };
  };

  // ---- timers, watchdog, diarization capture and local-mode state -------------

  let meetingSystemAudioTicker: NodeJS.Timeout | null = null;
  let meetingSystemAudioLevelPeak = 0;
  let meetingSystemAudioLevelSentAt = 0;
  let meetingSystemAudioWatchdogWin: CoordinatorWindowLike | null = null;

  const meetingSystemAudioWatchdog: MeetingSystemAudioWatchdog = createMeetingSystemAudioWatchdog({
    onResumed: () => {
      const win = meetingSystemAudioWatchdogWin;
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-system-audio-resumed");
      }
    },
    onInterrupted: (payload) => {
      // debugLogger.error flattens its arguments into one string, dropping
      // both the meta and the scope, so the give-up event would vanish from a
      // log filtered on "meeting", the one filter used to triage this bug.
      if (payload.recovering) {
        debugLogger.warn("Meeting system audio interrupted, restarting", payload, "meeting");
      } else {
        debugLogger.warn("Meeting system audio capture gave up", payload, "meeting");
      }
      const win = meetingSystemAudioWatchdogWin;
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-system-audio-interrupted", payload);
      }
    },
  });

  const clearMeetingSystemAudioTicker = () => {
    if (meetingSystemAudioTicker) {
      clearInterval(meetingSystemAudioTicker);
      meetingSystemAudioTicker = null;
    }
  };

  const stopMeetingSystemAudioWatchdog = () => {
    clearMeetingSystemAudioTicker();
    meetingSystemAudioWatchdog.stop();
    meetingSystemAudioWatchdogWin = null;
  };

  const startMeetingSystemAudioWatchdog = (
    win: CoordinatorWindowLike | null,
    systemAudioStrategy: string
  ) => {
    clearMeetingSystemAudioTicker();
    meetingSystemAudioWatchdogWin = win;
    meetingSystemAudioWatchdog.start({
      systemAudioStrategy,
      watchesDelivery: systemAudioStrategy === "native",
    });
    meetingSystemAudioTicker = setInterval(
      () => meetingSystemAudioWatchdog.tick(),
      MEETING_SYSTEM_AUDIO_TICK_MS
    );
  };

  // ---- prepare / start / send / stop -------------------------------------------

  ipcMain.handle(
    "meeting-transcription-prepare",
    async () => {
      if (meetingTranscriptionStartInProgress || activeCaptureSession) {
        return { success: false, error: "Meeting capture is already active" };
      }
      try {
        await getMeetingSystemAudioPlan();
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle("meeting-transcription-cancel", async () => {
    if (meetingTranscriptionStartInProgress || activeCaptureSession) {
      return { success: false, reason: "recording-active" };
    }
    return { success: true };
  });

  const meetingFailure = (error: unknown): MeetingStartFailure => {
    const err = error as { message?: string; code?: string; messageKey?: string };
    return {
      success: false,
      error: err?.message || String(error),
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.messageKey ? { messageKey: err.messageKey } : {}),
    };
  };

  let shuttingDown = false;
  const captureStarts = new Set<Promise<unknown>>();

  const startMeetingTranscription = async (
    event: { sender: WebContents },
    options: Record<string, unknown> = {}
  ) => {
    if (shuttingDown) return { success: false, error: "Meeting capture is shutting down" };
    if (activeCaptureSession || meetingTranscriptionStartInProgress) {
      return { success: false, error: "Meeting capture is already active" };
    }
    const noteId = typeof options.noteId === "number" ? options.noteId : null;
    const sessionId = typeof options.sessionId === "string" ? options.sessionId : "";
    if (!noteId || !Number.isSafeInteger(noteId) || noteId < 1 || !sessionId) {
      return { success: false, error: "A saved note and capture session are required" };
    }

    meetingTranscriptionStartInProgress = true;
    const startedAt = new Date();
    const configInput = options.recordingConfig;
    const safeConfig = meetingRecordingConfigInputSchema.safeParse(configInput);
    const recordingConfig = safeConfig.success
      ? { config: safeConfig.data.config, configError: safeConfig.data.configError ?? null }
      : { config: null, configError: { code: "invalid-config" } };

    let capture: MeetingCaptureSession;
    try {
      capture = MeetingCaptureSession.create(
        databaseManager,
        deps.meetingRecordingStorage,
        noteId,
        recordingConfig,
        startedAt,
        undefined,
        typeof options.groupId === "string" ? options.groupId : undefined,
        options.manualMicMuted === true
      );
    } catch (error) {
      meetingTranscriptionStartInProgress = false;
      return meetingFailure(error);
    }

    captureDraining = false;
    pausedRecording = null;
    platformMuted = false;
    browserClocks.clear(); meetEvidence.reset(); meetCoverage = null;
    activeCaptureSession = capture;
    platformCollector = new ZoomSpeakerCollector(capture.recordingId, {
      saveMeetingPlatformObservation: (observation) => databaseManager.saveMeetingPlatformObservation(observation),
      saveMeetingAudioClockAnchor: (anchor) => databaseManager.saveMeetingAudioClockAnchor(anchor),
      setMeetingPlatformCoverage: (id, coverage) => databaseManager.setMeetingPlatformCoverage(id, coverage),
    });
    try { platformCollector.start(); } catch { platformCollector.invalidate("ax-helper-start-failed"); }
    activeCaptureSessionId = sessionId;
    activeCaptureOwner = event.sender;
    linkRecordingSessionToNote(noteId);
    deps.onCaptureStarted?.(noteId);
    meetingDetectionEngine?.setUserRecording(true);

    let systemAudioMode: "native" | "unsupported" = "unsupported";
    let systemAudioStrategy: "native" | "unsupported" = "unsupported";
    try {
      const plan = await getMeetingSystemAudioPlan();
      systemAudioMode = plan.mode;
      systemAudioStrategy = plan.strategy;
      await meetingDetectionEngine?.beginRecordingSession({
        sessionId,
        autoEndEligible: options.autoEndEligible === true,
        ownerWebContents: event.sender,
        systemAudioAvailable: false,
      });

      const restartCandidate = typeof options.restartSessionId === "string"
        ? lastStoppedBinding?.sessionId === options.restartSessionId ? lastStoppedBinding.candidate : null : undefined;
      companion.start({ recordingId: capture.recordingId, sessionId }, restartCandidate);
      capture.initializePlatformMute(platformMuted);

      if (plan.mode === "native" && audioTapManager) {
        try {
          await startManagedMeetingSystemAudio(event, capture, audioTapManager);
        } catch (error) {
          capture.markSourceUnavailable("system", "system-audio-unavailable");
          stopMeetingSystemAudioWatchdog();
          systemAudioMode = "unsupported";
          systemAudioStrategy = "unsupported";
          debugLogger.warn("Native meeting system capture is unavailable", {
            error: error instanceof Error ? error.message : String(error),
          }, "meeting");
        }
      }

      deps.setMeetingCaptureState?.(true);
      return {
        success: true,
        sessionId,
        recordingId: capture.recordingId,
        originAt: capture.originAt,
        monotonicOriginNs: capture.getMonotonicOriginNs(),
        helperGeneration: audioTapManager?.getClockOrigin()?.helperGeneration,
        platformMicMuted: platformMuted,
        systemAudioMode,
        systemAudioStrategy,
      };
    } catch (error) {
      capture.markCaptureFailure("capture-start-failed");
      await platformCollector?.stop();
      platformCollector = null;
      try {
        await audioTapManager?.stop();
        await capture.stop({ lastSequence: {}, errorCode: "capture-start-failed" });
      } catch (stopError) {
        debugLogger.error("Failed to finalize a meeting capture that did not start", {
          error: stopError instanceof Error ? stopError.message : String(stopError),
          recordingId: capture.recordingId,
        }, "meeting");
      }
      companion.stop({ recordingId: capture.recordingId, sessionId });
      releaseCaptureOwnership(capture, sessionId);
      meetingDetectionEngine?.endRecordingSession(sessionId);
      meetingDetectionEngine?.setUserRecording(false);
      return { ...meetingFailure(error), recordingId: capture.recordingId };
    } finally {
      meetingTranscriptionStartInProgress = false;
    }
  };

  const sendMeetingAudio = (
    audioBuffer: unknown,
    source: MeetingAudioSource,
    sessionId: string,
    packet: { epochIndex: number; epochStartFrame: number; sequence: number; sampleOffset: number }
  ) => {
    const capture = activeCaptureSession;
    if (!capture || sessionId !== activeCaptureSessionId) {
      throw new Error("Meeting capture session is no longer active");
    }
    if (!Buffer.isBuffer(audioBuffer) && !(audioBuffer instanceof ArrayBuffer)) {
      throw new Error("Meeting capture packet must be an ArrayBuffer");
    }
    if (source !== "mic" && source !== "system") {
      throw new Error("Meeting capture source is invalid");
    }
    const parsedPacket = meetingCapturePacketSchema.safeParse(packet);
    if (!parsedPacket.success) throw new Error("Meeting capture packet metadata is invalid");
    const raw = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    capture.appendRendererSamples(source, parsedPacket.data, raw);
    meetingDetectionEngine?.recordMeetingAudioChunk(source, raw);
    return { success: true, sequence: parsedPacket.data.sequence };
  };

  const startManagedMeetingSystemAudio = async (
    event: { sender: WebContents },
    capture: MeetingCaptureSession,
    manager: NonNullable<MeetingCoordinatorDeps["audioTapManager"]>
  ): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const timeline = createMeetingAudioTimeline();
    const reportLevel = (rms: number) => {
      meetingSystemAudioLevelPeak = Math.max(meetingSystemAudioLevelPeak, rms);
      const now = Date.now();
      if (now - meetingSystemAudioLevelSentAt < MEETING_SYSTEM_AUDIO_LEVEL_INTERVAL_MS) return;
      meetingSystemAudioLevelSentAt = now;
      if (win && !win.isDestroyed()) {
        win.webContents.send(
          "meeting-system-audio-level",
          Math.min(1, meetingSystemAudioLevelPeak)
        );
      }
      meetingSystemAudioLevelPeak = 0;
    };
    let generation: string | undefined;
    let generationFrameOrigin = 0;
    let sourceGeneration = 0;
    const evidence = platformCollector;
    const startCapture = () =>
      manager.start({
        onStart: (message) => {
          generation = message.generation;
          if (!message.generation || !message.monotonicOriginNs || message.originFrame !== 0) {
            capture.markSourceUnavailable("system", "audio-clock-unavailable");
            throw new Error("Native audio tap did not provide its actual frame clock");
          }
          if (capture.getMonotonicOriginNs() === null) capture.setMonotonicOriginNs(message.monotonicOriginNs);
          const startFrame = capture.frameForMonotonicNs(message.monotonicOriginNs);
          if (startFrame === null) throw new Error("Native audio tap clock cannot be mapped to the recording origin");
          generationFrameOrigin = startFrame;
          const epochIndex = capture.beginSourceEpoch("system", ++sourceGeneration, 0, startFrame);
          if (generation) evidence?.bindClock(generation, epochIndex, startFrame);
          else evidence?.invalidate("clock-generation-missing");
        },
        onClock: (clock) => evidence?.recordClock(clock),
        onChunk: (chunk, sourceFrameStart) => {
          try {
            const frameStart = generationFrameOrigin + sourceFrameStart;
            timeline.write(chunk, frameStart, (raw, anchoredFrameStart) => {
              capture.appendNativeSamples("system", sourceGeneration, raw, sourceFrameStart, anchoredFrameStart);
              evidence?.recordDeliveredFrames(generation, raw.length / 2);
              meetingDetectionEngine?.recordMeetingAudioChunk("system", raw);
              const { rms, peak } = computeChunkStats(raw);
              reportLevel(rms);
              meetingSystemAudioWatchdog.recordChunk(
                rms >= MEETING_MIC_SILENCE_RMS || peak >= MEETING_MIC_SILENCE_PEAK
              );
            });
          } catch (error) {
            capture.markCaptureFailure("audio-write-failed");
            const message = error instanceof Error ? error.message : String(error);
            if (win && !win.isDestroyed()) {
              win.webContents.send("meeting-transcription-fatal-error", message);
            }
            if (activeCaptureSessionId) {
              void stopMeetingTranscription(activeCaptureSessionId, { incomplete: true });
            }
          }
        },
        onError: (error) => {
          capture.markSourceUnavailable("system", "system-audio-interrupted");
          debugLogger.warn("Meeting system audio helper failed; attempting recovery", {
            error: error.message,
          }, "meeting");
          meetingSystemAudioWatchdog.reportCaptureFailed();
        },
        onWarning: (warning) => {
          debugLogger.warn("macOS system audio tap warning", {
            code: warning.code,
            message: warning.message,
          }, "meeting");
          if (warning.code === "clock_queue_overflow" || warning.code === "clock_invalid_message") {
            evidence?.invalidate(warning.code);
          }
          if (warning.code === "device_invalidated") {
            meetingSystemAudioWatchdog.reportDeviceInvalidated();
          }
        },
      });

    startMeetingSystemAudioWatchdog(win, "native");
    meetingSystemAudioWatchdog.attachCapture({
      stop: () => manager.stop(),
      start: startCapture,
    });
    await startCapture();
  };

  ipcMain.handle(
    "meeting-transcription-send",
    (_event, audioBuffer: unknown, source: MeetingAudioSource, sessionId: string, packet: unknown) =>
      sendMeetingAudio(audioBuffer, source, sessionId, packet as {
        epochIndex: number;
        epochStartFrame: number;
        sequence: number;
        sampleOffset: number;
      })
  );

  ipcMain.handle("meeting-transcription-set-mic-intent", async (event, request: unknown) => {
    const parsed = meetingMicIntentRequestSchema.safeParse(request);
    if (!parsed.success) return { success: false, error: "Microphone intent request is invalid" };
    const capture = activeCaptureSession;
    if (!capture || event.sender !== activeCaptureOwner ||
        parsed.data.sessionId !== activeCaptureSessionId || parsed.data.recordingId !== capture.recordingId) {
      return { success: false, error: "Microphone intent belongs to a stale recording" };
    }
    try {
      const result = await capture.setMicIntent(parsed.data);
      companionServer?.broadcastSnapshot();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Microphone intent was rejected" };
    }
  });

  ipcMain.handle("meeting-transcription-probe-clock", async (event, request: unknown) => {
    const parsed = meetingClockProbeRequestSchema.safeParse(request);
    const capture = activeCaptureSession;
    if (!parsed.success || !audioTapManager || !capture || event.sender !== activeCaptureOwner ||
        parsed.data.sessionId !== activeCaptureSessionId || parsed.data.recordingId !== capture.recordingId) {
      return { success: false, error: "Clock probe belongs to a stale recording" };
    }
    try {
      const reply = await audioTapManager.probeClock(parsed.data.nonce);
      return { success: true, ...reply };
    } catch (error) {
      return { success: false, nonce: parsed.data.nonce, error: error instanceof Error ? error.message : "Clock probe failed" };
    }
  });

  const stopMeetingTranscription = async (
    expectedSessionId: string,
    options: {
      incomplete?: boolean;
      lastSequence?: Partial<Record<MeetingAudioSource, number>>;
      microphoneBoundary?: import("../contracts/meetingCoordinator.js").MeetingCaptureStopRequest["microphoneBoundary"];
      errorCode?: string;
      suppressProcessing?: boolean;
      pause?: boolean;
    } = {}
  ) => {
    const capture = activeCaptureSession;
    if (!capture || expectedSessionId !== activeCaptureSessionId) {
      return { success: false, reason: "stale-session" };
    }
    captureDraining = true;
    deps.dismissCompanionReminder?.({ recordingId: capture.recordingId, sessionId: expectedSessionId });
    lastStoppedBinding = { sessionId: expectedSessionId, candidate: companion.status().binding };
    companion.stop({ recordingId: capture.recordingId, sessionId: expectedSessionId });
    if (options.incomplete) capture.markCaptureFailure(options.errorCode ?? "renderer-lost");
    meetingDetectionEngine?.endRecordingSession(expectedSessionId);
    meetingDetectionEngine?.setUserRecording(false);
    stopMeetingSystemAudioWatchdog();

    const collector = platformCollector;
    let stopError: string | null = null;
    try {
      await audioTapManager?.stop();
    } catch (error) {
      stopError = "audio-flush-failed";
      capture.markCaptureFailure(stopError);
      debugLogger.error("Meeting system audio tail did not drain", {
        error: error instanceof Error ? error.message : String(error),
      }, "meeting");
    }

    platformCollector = null;
    await collector?.stop();
    if (meetCoverage) {
      const reason = meetCoverage.reason ?? (meetCoverage.samples ? null : "no-calibrated-meet-evidence");
      try { databaseManager.setMeetingPlatformCoverage(capture.recordingId, { ...meetCoverage, reason, state: reason ? "incomplete" : "complete" }); } catch { /* Optional metadata never prevents raw audio finalization. */ }
    }
    try {
      const result = await capture.stop({
        lastSequence: options.lastSequence ?? {},
        microphoneBoundary: options.microphoneBoundary,
        errorCode: stopError,
      });
      if (options.suppressProcessing) deps.cancelInitialProcessingRun?.(result.initialRunId);
      pausedRecording = options.pause && result.captureState === "ready" ? { recordingId: capture.recordingId, manualMuted: capture.getMicIntent().manualMuted } : null;
      releaseCaptureOwnership(capture, expectedSessionId);
      resolveSafeStop?.({ success: true, captureState: result.captureState });
      return {
        success: true,
        recordingId: result.recordingId,
        initialRunId: result.initialRunId,
        captureState: result.captureState,
        errorCode: result.errorCode,
      };
    } catch (error) {
      debugLogger.error("Meeting capture finalization failed", {
        error: error instanceof Error ? error.message : String(error),
        recordingId: capture.recordingId,
      }, "meeting");
      releaseCaptureOwnership(capture, expectedSessionId);
      resolveSafeStop?.({ success: false });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const meetingTranscriptionLifecycle = createMeetingTranscriptionLifecycle({
    start: ({ sessionId, ownerWebContents, options }) =>
      startMeetingTranscription(
        { sender: ownerWebContents as WebContents },
        { ...options, sessionId }
      ),
    stop: (sessionId, options) => stopMeetingTranscription(sessionId, options),
    onError: (error, sessionId) => {
      debugLogger.error(
        "Meeting transcription owner-loss teardown failed",
        {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        },
        "meeting"
      );
    },
  });

  const currentRecordingScope = (): MeetingRecordingScope | null =>
    activeCaptureSession && activeCaptureSessionId
      ? { recordingId: activeCaptureSession.recordingId, sessionId: activeCaptureSessionId } : null;

  const requestSafeStop = ({ expected, reason, suppressProcessing = false }: MeetingSafeStopOptions): Promise<{
    success: boolean;
    captureState?: "ready" | "incomplete";
  }> => {
    if (!activeCaptureSessionId || !activeCaptureSession ||
        activeCaptureSessionId !== expected.sessionId || activeCaptureSession.recordingId !== expected.recordingId) {
      return Promise.resolve({ success: false });
    }
    if (safeStopPromise) return safeStopScope?.sessionId === expected.sessionId && safeStopScope.recordingId === expected.recordingId
      ? safeStopPromise : Promise.resolve({ success: false });
    safeStopScope = expected;

    const sessionId = activeCaptureSessionId;
    const pendingSafeStop = new Promise<{
      success: boolean;
      captureState?: "ready" | "incomplete";
    }>((resolve) => {
      let timeout: NodeJS.Timeout | null = null;
      const settle = (result: { success: boolean; captureState?: "ready" | "incomplete" }) => {
        if (timeout) clearTimeout(timeout);
        resolveSafeStop = null;
        resolve(result);
      };
      resolveSafeStop = settle;

      const owner = activeCaptureOwner;
      if (!owner || owner.isDestroyed()) {
        void meetingTranscriptionLifecycle
          .stopSession(sessionId, { incomplete: true, suppressProcessing })
          .then((result) => settle({ success: result.success, captureState: result.captureState }));
        return;
      }

      timeout = setTimeout(() => {
        void meetingTranscriptionLifecycle
          .stopSession(sessionId, { incomplete: true, suppressProcessing })
          .then((result) => settle({ success: result.success, captureState: result.captureState }));
      }, 5000);
      owner.send("meeting-transcription-stop-requested", { sessionId, recordingId: expected.recordingId, reason, suppressProcessing });
    }).finally(() => {
      safeStopPromise = null;
      safeStopScope = null;
      resolveSafeStop = null;
    });
    safeStopPromise = pendingSafeStop;
    return pendingSafeStop;
  };

  ipcMain.handle("meeting-transcription-start", (event, options: Record<string, unknown> = {}) => {
    if (shuttingDown) return { success: false, error: "Meeting capture is shutting down" };
    const parsed = meetingOptionsSchema.safeParse(options);
    if (!parsed.success) return meetingFailure(new Error("Meeting capture start request is invalid"));
    const sessionId =
      typeof parsed.data.sessionId === "string" && parsed.data.sessionId.length > 0
        ? parsed.data.sessionId
        : crypto.randomUUID();
    const start = meetingTranscriptionLifecycle.startSession({
      sessionId,
      ownerWebContents: event.sender,
      options: parsed.data,
    });
    captureStarts.add(start);
    return start.finally(() => { captureStarts.delete(start); });
  });

  ipcMain.handle(
    "meeting-transcription-stop",
    (_event, request: unknown) => {
      const parsed = meetingCaptureStopRequestSchema.safeParse(request);
      if (!parsed.success) return { success: false, error: "Meeting capture stop request is invalid" };
      return meetingTranscriptionLifecycle.stopSession(parsed.data.sessionId, {
        incomplete: parsed.data.incomplete === true,
        lastSequence: parsed.data.lastSequence,
        microphoneBoundary: parsed.data.microphoneBoundary,
        pause: parsed.data.pause,
        errorCode: parsed.data.errorCode,
        suppressProcessing: parsed.data.suppressProcessing,
      });
    }
  );

  ipcMain.handle(
    "meeting-transcription-set-system-audio-available",
    async (event, sessionId: string, available: boolean) => {
      if (activeCaptureSessionId === sessionId && available !== true) {
        activeCaptureSession?.markSourceUnavailable("system", "system-audio-unavailable");
      }
      const updated = await meetingDetectionEngine?.setRecordingSystemAudioAvailable(
        sessionId,
        available === true,
        event.sender
      );
      return updated === true ? { success: true } : { success: false, reason: "stale-session" };
    }
  );

  ipcMain.handle("acquire-recording-lock", async (_event, pipeline: string) => {
    if (activeRecordingPipeline && activeRecordingPipeline !== pipeline) {
      return { success: false, holder: activeRecordingPipeline };
    }
    activeRecordingPipeline = pipeline;
    return { success: true };
  });

  ipcMain.handle("release-recording-lock", async (_event, pipeline: string) => {
    if (activeRecordingPipeline === pipeline) {
      activeRecordingPipeline = null;
    }
    return { success: true };
  });

  // Every window's AudioManager can hold the mic open outside a recording, so
  // gate the audio-evidence meeting detector until they all release. A
  // renderer that reloads or goes away releases implicitly — otherwise a
  // crash mid-hold would gate detection for the rest of the session.
  ipcMain.on("mic-warm-hold-changed", (event: IpcMainEvent, active: boolean) => {
    const sender = event.sender;
    if (!active) {
      releaseMicHold(sender);
      return;
    }
    if (micHoldSenders.has(sender.id)) return;
    const release = () => releaseMicHold(sender);
    micHoldSenders.set(sender.id, release);
    sender.on("destroyed", release);
    sender.on("did-finish-load", release);
    meetingDetectionEngine?.setMicWarmHold(true);
  });

  ipcMain.handle("meeting-detection-get-preferences", async () => {
    try {
      return { success: true, preferences: meetingDetectionEngine!.getPreferences() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle("meeting-detection-set-preferences", async (_event, prefs: Record<string, boolean>) => {
    try {
      meetingDetectionEngine!.setPreferences(prefs);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(
    "meeting-set-session-speaker-config",
    async (_event, payload?: { enabled?: boolean; expectedCount?: number; countIsExplicit?: boolean }) => {
      try {
        const enabled = payload?.enabled !== false;
        const expectedCount = Math.max(
          1,
          Math.min(MAX_SPEAKER_COUNT, Number(payload?.expectedCount) || DEFAULT_EXPECTED_SPEAKER_COUNT)
        );
        // Only a stepper-set count is explicit; the diarization toggle reuses this
        // channel and must not freeze the count against roster-driven refreshes.
        activeMeetingSpeakerConfig = {
          enabled,
          expectedCount,
          explicit: payload?.countIsExplicit === true,
        };
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle("meeting-notification-respond", async (_event, detectionId: string, action: string) => {
    try {
      await meetingDetectionEngine!.handleNotificationResponse(detectionId, action);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  registerMeetingAutoEndLifecycleHandlers(ipcMain, () => meetingDetectionEngine);

  ipcMain.handle("join-calendar-meeting", async (_event, eventId: string) => {
    try {
      await meetingDetectionEngine!.joinCalendarMeeting(eventId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle("find-calendar-event-note", async (_event, eventId: string) => {
    return meetingDetectionEngine?.findCalendarEventNote(eventId) ?? null;
  });

  ipcMain.handle(
    "create-calendar-event-note",
    async (_event, eventId: string, initial: { title?: unknown; content?: unknown } | null) => {
      return (
        meetingDetectionEngine?.createCalendarEventNote(eventId, {
          title: typeof initial?.title === "string" ? initial.title : undefined,
          content: typeof initial?.content === "string" ? initial.content : undefined,
        }) ?? null
      );
    }
  );

  ipcMain.handle("get-meeting-notification-data", async () => {
    return deps.getMeetingNotificationData?.() ?? null;
  });

  ipcMain.handle("get-pending-meeting-note-navigation", async () => {
    return deps.consumePendingMeetingNoteNavigation?.() ?? null;
  });

  ipcMain.handle("meeting-notification-ready", async (event: IpcMainInvokeEvent) => {
    deps.showNotificationWindow?.(event.sender);
  });

  const disposeCompanion = async () => {
    if (companionTicker) clearInterval(companionTicker);
    await companionStarted?.catch(() => {});
    if (companionTicker) clearInterval(companionTicker);
    await companionServer?.stop();
  };

  return {
    isRecording: () => activeCaptureSession !== null,
    shutdown: async () => {
      shuttingDown = true;
      await Promise.allSettled([...captureStarts]);
      const expected = currentRecordingScope();
      if (expected) {
        const result = await requestSafeStop({ expected, reason: "quit", suppressProcessing: true });
        if (!result.success) throw new Error("Meeting capture could not be stopped safely");
      }
      await audioTapManager?.stop();
      await disposeCompanion();
    },
    startCompanion: () => {
      if (shuttingDown) return Promise.reject(new Error("Meeting capture is shutting down"));
      companionStarted ??= (async () => {
        await companionServer?.start();
        if (companionServer) { companionTicker = setInterval(() => companion.tick(), 1000); companionTicker.unref(); }
      })();
      return companionStarted;
    },
    setCompanionEnabled: (enabled) => companion.setEnabled(enabled),
    disposeCompanion,
    requestSafeStop,
    currentRecordingScope,
    linkRecordingSessionToNote,
    refreshMeetingSpeakerConfigFromNote(noteId, note) {
      const config = activeMeetingSpeakerConfig;
      if (!config || config.explicit) return;
      if (noteId == null || activeMeetingNoteId !== noteId) return;

      const expectedCount = noteExpectedSpeakerCountOrNull(rosterDeps, note);
      if (expectedCount == null || expectedCount <= config.expectedCount) return;

      activeMeetingSpeakerConfig = { ...config, expectedCount };
      broadcastToWindows("meeting-session-speaker-config-updated", {
        enabled: config.enabled,
        expectedCount,
      });
      debugLogger.info(
        "Meeting speaker config refreshed from participants",
        { noteId, expectedCount },
        "speaker"
      );
    },
    resolveOneOnOneOtherParticipant: (participantsJson) =>
      resolveOneOnOneOtherParticipant(rosterDeps, participantsJson),
  };

  function releaseMicHold(sender: { id: number; off(event: string, listener: () => void): unknown }): void {
    const release = micHoldSenders.get(sender.id);
    if (!release) return;
    micHoldSenders.delete(sender.id);
    sender.off("destroyed", release);
    sender.off("did-finish-load", release);
    meetingDetectionEngine?.setMicWarmHold(micHoldSenders.size > 0);
  }
}
