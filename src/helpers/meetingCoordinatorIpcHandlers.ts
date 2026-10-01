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
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import {
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import debugLogger from "./debugLogger.js";
import {
  ALLOWED_MEETING_PROVIDERS,
  getMeetingConnectionKey,
  getMeetingStreamingClient,
  type MeetingConnectionOptions,
  type MeetingStreamingClient,
  type MeetingStreamingProvider,
} from "./meetingStreamingProviders.js";
import {
  createMeetingSystemAudioWatchdog,
  type MeetingSystemAudioWatchdog,
} from "./meetingSystemAudioWatchdog.js";
import { MeetingEchoLeakDetector, type MicSegmentSuppression } from "./meetingEchoLeakDetector.js";
import {
  partitionPendingMicFinals,
  partitionOverlappingPendingMicFinals,
  isDuplicateMicSegment,
  isRiskyMicDuplicateProfile,
  selectRacingMicEntryIndices,
} from "./meetingMicHoldback.js";
import {
  computeChunkStats,
  resolveMicChunkAction,
  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
} from "./meetingMicGate.js";
import { resolveDiarizationInput } from "./meetingDiarizationInput.js";
import {
  transcriptsOverlap,
  transcriptsLooselyOverlap,
  buildMergedCandidates,
} from "./transcriptText.js";
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
import { downsample24kTo16k, pcm16ToWav } from "../utils/audioUtils.js";
import { isSherpaLocalProvider } from "./parakeetModelInfo.js";
import { resolveContextSileroEnabled } from "./whisperVadConfig.js";
import { supportsLiveSpeakerIdentification } from "./liveSpeakerIdPolicy.js";
import type { LiveSpeakerIdentifier, SpeakerReclusterMerge } from "./liveSpeakerIdentifier.js";
import type { AudioTapManager } from "./audioTapManager.js";
import type { MeetingDetectionEngine } from "./meetingDetectionEngine.js";
import { broadcastToWindows } from "./windowBroadcast.js";
import {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
  getNoteNonSelfParticipants,
  noteExpectedSpeakerCountOrNull,
  resolveInitialMeetingSpeakerConfig,
  resolveOneOnOneOtherParticipant,
  startOrSkipMeetingDiarization,
  type DiarizationPublicationDatabase,
  type MeetingSessionSpeakerConfig,
  type MeetingSpeakerRosterNote,
  type MeetingStoredSegment,
  type SpeakerEmbeddingsLike,
} from "./meetingDiarizationPublication.js";

// Meeting capture runs at 24 kHz (see meetingRecordingStore AudioContext); realtime
// streaming providers must be told the true PCM rate or they misread the audio.
const MEETING_STREAM_SAMPLE_RATE = 24000;
const MEETING_RECONNECT_BUFFER_MAX_BYTES = MEETING_STREAM_SAMPLE_RATE * 2 * 30;
// The realtime clients default to a 0.6 server-VAD threshold, raised in #630 to
// keep mic ambient noise from opening turns. The direct system-audio channel
// uses a lower threshold so quiet remote speech still opens a turn.
const MEETING_SYSTEM_VAD_THRESHOLD = 0.3;

const DUPLICATE_TRANSCRIPT_WINDOW_MS = 6000;
const DUPLICATE_TRANSCRIPT_MERGE_LIMIT = 3;
const STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS = 3000;
const LOCAL_MEETING_CHUNK_INTERVAL_MS = 5000;
// Must outlast one local transcription cycle so a straddling remote
// utterance's next-cycle system transcript can confirm buffered echo.
const LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS = LOCAL_MEETING_CHUNK_INTERVAL_MS + 1000;
const RACING_MIC_RETRACT_WINDOW_MS = 4000;
const MEETING_STARTUP_WARMUP_MS = 1500;
const MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS = 45000;
const MEETING_SYSTEM_AUDIO_TICK_MS = 2000;
// Level meters (in-app pill, companion) only need ~20 updates a second.
const MEETING_SYSTEM_AUDIO_LEVEL_INTERVAL_MS = 50;
const MAX_MEETING_RECONNECTS = 5;

export type MeetingAudioSource = "mic" | "system";

export interface CoordinatorWindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload?: unknown): void };
}

export interface CoordinatorLiveSpeakerIdentifier {
  isAvailable(): boolean;
  start(
    onSpeakerIdentified: (identification: {
      speakerId: string;
      displayName: string | null;
      startTime: number;
      endTime: number;
      [key: string]: unknown;
    }) => void,
    options: {
      getSpeakerProfiles: () => ReturnType<DiarizationPublicationDatabase["getSpeakerProfiles"]>;
      maxSpeakers: number;
      enabled: boolean;
    }
  ): Promise<boolean>;
  stop(): Promise<Record<string, unknown>>;
  feedAudio(pcmBuffer: Buffer): Promise<unknown>;
  recluster(): Promise<SpeakerReclusterMerge[]>;
  setEnabled(enabled: boolean): void;
  setMaxSpeakers(n: number): void;
  getSpeakerEmbedding(speakerId: string): Float32Array | null;
  mapSpeaker(
    speakerId: string,
    profileId: number | null,
    displayName: string | null,
    noteId: number | null
  ): void;
}

export interface MeetingCoordinatorDeps {
  companionProfilePath?: string;
  companionEnabled?: boolean;
  showCompanionReminder?(scope: MeetingRecordingScope): void;
  dismissCompanionReminder?(scope: MeetingRecordingScope, sender?: WebContents): boolean;
  databaseManager: DiarizationPublicationDatabase & import("./meetingCaptureSession.js").MeetingCaptureDatabase & MeetingPlatformEvidenceDatabase;
  meetingRecordingStorage: MeetingCaptureEpochStorage;
  cancelInitialProcessingRun?: (runId: string) => boolean;
  diarizationManager: import("./meetingDiarizationPublication.js").DiarizationPublicationDiarizationManager;
  meetingDetectionEngine: (Pick<MeetingDetectionEngine,
    "setUserRecording" | "beginRecordingSession" | "endRecordingSession" |
    "recordMeetingAudioChunk" | "setRecordingSystemAudioAvailable" | "setMicWarmHold" |
    "getPreferences" | "setPreferences" | "handleNotificationResponse" |
    "joinCalendarMeeting" | "findCalendarEventNote" | "createCalendarEventNote"> & MeetingAutoEndEngineLike) | null;
  suppressPlatformAutoEnd?(sessionId: string): void;
  preparePlatformLeave?(sessionId: string): boolean;
  audioTapManager: Pick<AudioTapManager, "isSupported" | "start" | "stop" | "probeClock" | "getClockOrigin"> | null;
  whisperManager: {
    transcribeLocalWhisper(
      audio: Buffer,
      options: Record<string, unknown>
    ): Promise<{ success?: boolean; text?: string | null } | null | undefined>;
  };
  parakeetManager: {
    transcribeLocalParakeet(
      audio: Buffer,
      options: Record<string, unknown>
    ): Promise<{ success?: boolean; text?: string | null } | null | undefined>;
  };
  liveSpeakerIdentifier: CoordinatorLiveSpeakerIdentifier;
  // The realtime-token resolver (provider allowlist, env keys, Corti mint)
  // stays owned by the composition root, as before the migration.
  fetchRealtimeToken(event: { sender: WebContents }, options: MeetingConnectionOptions): Promise<string>;
  fetchRealtimeToken(
    event: { sender: WebContents },
    options: MeetingConnectionOptions,
    extra: { streams: 2 }
  ): Promise<[string, string]>;
  resolveWhisperVadOptions(context: string): Record<string, unknown>;
  // Lazy speaker-embeddings loader (ONNX worker client must stay out of
  // registration); see meetingDiarizationPublication.
  speakerEmbeddings: () => SpeakerEmbeddingsLike;
  // Narrow window-manager surface (notification window + note navigation +
  // the diarization target window), owned by the composition root.
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

interface PendingMicFinalEntry {
  text: string;
  timestamp: number;
  micSuppression: MicSegmentSuppression | null;
  holdbackMs: number;
  releaseAt: number;
  emit: () => void;
}

interface ReconnectAudioEntry {
  buffer: Buffer;
  capturedAt: number | null;
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

type MeetingStartInternalResult = {
  success: true;
  systemAudioMode?: string;
  systemAudioStrategy?: string;
  oneOnOneAttendee?: { displayName: string; email: string | null } | null;
};

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
    diarizationManager,
    meetingDetectionEngine,
    audioTapManager,
    whisperManager,
    parakeetManager,
    liveSpeakerIdentifier,
  } = deps;

  let meetingTranscriptionStartInProgress = false;
  let meetingTranscriptionPrepareInProgress = false;
  let prepareAbort: AbortController | null = null;
  let meetingTranscriptionPreparePromise: Promise<{
    success: boolean;
    error?: string;
    alreadyPrepared?: boolean;
  }> | null = null;
  let speakerDiarizationEnabled = true;
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
  const browserClockKey = (connectionId: string, ref: import("../contracts/companion.js").CompanionCallRef) => `${connectionId}/${ref.documentId}/${ref.callId}`;
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
      if (!companion.status().enabled || !binding || binding.connectionId !== connection.id || binding.ref.documentId !== message.ref.documentId || binding.ref.callId !== message.ref.callId) return;
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


  const publicationDeps = {
    databaseManager,
    diarizationManager,
    speakerEmbeddings: deps.speakerEmbeddings,
    isDiarizationEnabled: () => speakerDiarizationEnabled,
  };

  function linkRecordingSessionToNote(noteId: number | null): void {
    activeMeetingNoteId = noteId;
  }

  // ---- transcript dedup/holdback state --------------------------------------

  const meetingEchoLeakDetector = new MeetingEchoLeakDetector();
  let meetingDiarizationSegments: MeetingStoredSegment[] = [];
  let meetingPendingMicFinals: PendingMicFinalEntry[] = [];
  let meetingPendingMicFinalTimer: NodeJS.Timeout | null = null;

  const buildNearbyTranscriptCandidates = (
    targetSource: MeetingAudioSource,
    timestamp: number,
    {
      extraSegment = null,
    }: { extraSegment?: { text: string; timestamp: number | null } | null } = {}
  ) => {
    const relevant = meetingDiarizationSegments.filter(
      (candidate) =>
        candidate.source === targetSource && candidate.timestamp != null && candidate.text
    );

    return buildMergedCandidates({
      segments: relevant,
      timestamp,
      windowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
      mergeLimit: DUPLICATE_TRANSCRIPT_MERGE_LIMIT,
      extraSegment,
    });
  };

  const hasNearbyTranscriptMatch = (
    targetSource: MeetingAudioSource,
    text: string,
    timestamp: number,
    options: {
      relaxed?: boolean;
      extraSegment?: { text: string; timestamp: number | null } | null;
    } = {}
  ): boolean => {
    if (!text) return false;

    const matcher = options.relaxed ? transcriptsLooselyOverlap : transcriptsOverlap;
    const candidates = buildNearbyTranscriptCandidates(targetSource, timestamp, options);
    for (const candidateText of candidates) {
      if (matcher(text, candidateText)) {
        return true;
      }
    }

    return false;
  };

  const shouldSkipDuplicateMicSegment = (
    text: string,
    timestamp: number,
    suppression: MicSegmentSuppression | null = null
  ) => isDuplicateMicSegment({ text, timestamp, suppression, hasNearbyTranscriptMatch });

  const isWithinMeetingStartupWarmup = () =>
    meetingStartedAt != null && Date.now() - meetingStartedAt < MEETING_STARTUP_WARMUP_MS;

  const hasRiskyMicDuplicateProfile = (suppression: MicSegmentSuppression | null = null) =>
    isRiskyMicDuplicateProfile({
      suppression,
      inStartupWarmup: isWithinMeetingStartupWarmup(),
    });

  const removeRacingMicEntriesFor = (systemText: string, systemTimestamp: number) => {
    const indices = selectRacingMicEntryIndices({
      segments: meetingDiarizationSegments,
      systemText,
      systemTimestamp,
      hasNearbyTranscriptMatch,
      duplicateWindowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
      retractWindowMs: RACING_MIC_RETRACT_WINDOW_MS,
    });
    const removed: MeetingStoredSegment[] = [];
    // Indices are descending, so splicing in order never shifts a later index.
    for (const index of indices) {
      removed.push(meetingDiarizationSegments[index]);
      meetingDiarizationSegments.splice(index, 1);
    }
    return removed;
  };

  const appendMeetingLocalTranscript = (text: string) => {
    if (!text) return;
    meetingLocalTranscript += `${meetingLocalTranscript ? " " : ""}${text}`;
  };

  // Held-back mic segments are appended at release time, so insertion order
  // is not spoken order.
  const buildOrderedTranscriptText = (segments: MeetingStoredSegment[]) =>
    segments
      .slice()
      .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
      .map((segment) => segment.text)
      .join(" ")
      .trim();

  const storeMeetingDiarizationSegment = (
    text: string,
    source: MeetingAudioSource,
    timestamp: number,
    micSuppression: MicSegmentSuppression | null = null
  ) => {
    meetingDiarizationSegments.push({
      text,
      source,
      timestamp,
      committedAt: Date.now(),
      suppressionReason: source === "mic" ? micSuppression?.reason || null : null,
      hasBleedEvidence: source === "mic" ? !!micSuppression?.hasBleedEvidence : false,
      likelyRenderBleed: source === "mic" ? !!micSuppression?.likelyRenderBleed : false,
    });
  };

  type SegmentSend = (channel: string, data: unknown) => void;

  const sendMeetingFinalSegment = ({
    text,
    source,
    timestamp,
    micSuppression = null,
    send = null,
    includeInLocalTranscript = false,
  }: {
    text: string;
    source: MeetingAudioSource;
    timestamp: number;
    micSuppression?: MicSegmentSuppression | null;
    send?: SegmentSend | null;
    includeInLocalTranscript?: boolean;
  }) => {
    if (includeInLocalTranscript) {
      appendMeetingLocalTranscript(text);
    }

    storeMeetingDiarizationSegment(text, source, timestamp, micSuppression);

    if (send) {
      send("meeting-transcription-segment", {
        text,
        source,
        type: "final",
        timestamp,
      });
    }
  };

  function flushPendingMicFinals(force = false) {
    if (meetingPendingMicFinals.length === 0) {
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }
      return;
    }

    const { deferred, duplicates, releases } = partitionPendingMicFinals({
      pending: meetingPendingMicFinals,
      now: Date.now(),
      force,
      isDuplicate: (entry) =>
        shouldSkipDuplicateMicSegment(entry.text, entry.timestamp, entry.micSuppression),
    });

    meetingPendingMicFinals = deferred;
    schedulePendingMicFinalFlush();

    for (const pending of duplicates) {
      debugLogger.debug(
        "Dropping buffered mic segment after system context confirmed duplicate",
        {
          text: pending.text.slice(0, 80),
          averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
          averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
        }
      );
    }

    for (const pending of releases) {
      debugLogger.debug(
        pending.micSuppression?.hasBleedEvidence
          ? "Releasing bleed-flagged mic segment after holdback (no transcript match)"
          : "Releasing buffered mic segment after duplicate holdback",
        {
          text: pending.text.slice(0, 80),
          holdbackMs: pending.holdbackMs,
          reason: pending.micSuppression?.reason,
          averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
          averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
        }
      );
      pending.emit();
    }
  }

  const schedulePendingMicFinalFlush = () => {
    if (meetingPendingMicFinalTimer) {
      clearTimeout(meetingPendingMicFinalTimer);
      meetingPendingMicFinalTimer = null;
    }

    if (meetingPendingMicFinals.length === 0) {
      return;
    }

    const nextDelay = Math.max(0, meetingPendingMicFinals[0].releaseAt - Date.now());
    meetingPendingMicFinalTimer = setTimeout(() => {
      meetingPendingMicFinalTimer = null;
      flushPendingMicFinals();
    }, nextDelay);
  };

  const resetPendingMicFinals = () => {
    meetingPendingMicFinals = [];
    if (meetingPendingMicFinalTimer) {
      clearTimeout(meetingPendingMicFinalTimer);
      meetingPendingMicFinalTimer = null;
    }
  };

  const removePendingMicFinalsFor = (systemText: string, systemTimestamp: number) => {
    const { kept, removed } = partitionOverlappingPendingMicFinals({
      pending: meetingPendingMicFinals,
      systemText,
      systemTimestamp,
      hasNearbyTranscriptMatch,
    });
    meetingPendingMicFinals = kept;
    schedulePendingMicFinalFlush();
    return removed;
  };

  const queuePendingMicFinal = ({
    text,
    timestamp,
    micSuppression,
    holdbackMs,
    emit,
  }: {
    text: string;
    timestamp: number;
    micSuppression: MicSegmentSuppression | null;
    holdbackMs: number;
    emit: () => void;
  }) => {
    meetingPendingMicFinals.push({
      text,
      timestamp,
      micSuppression,
      holdbackMs,
      releaseAt: Date.now() + holdbackMs,
      emit,
    });
    meetingPendingMicFinals.sort((left, right) => left.releaseAt - right.releaseAt);
    schedulePendingMicFinalFlush();
  };

  const captureMeetingDiarizationState = async () => {
    const systemPcmPath = meetingDiarizationPath;
    const systemStartedAt = meetingDiarizationStartedAt;
    const micPcmPath = meetingMicDiarizationPath;
    const micStartedAt = meetingMicDiarizationStartedAt;
    const systemAudioHeard = meetingSystemAudioHeard;
    const diarizationSegments = meetingDiarizationSegments;
    if (meetingDiarizationStream) {
      await new Promise<void>((resolve) => meetingDiarizationStream!.end(resolve));
      meetingDiarizationStream = null;
    }
    if (meetingMicDiarizationStream) {
      await new Promise<void>((resolve) => meetingMicDiarizationStream!.end(resolve));
      meetingMicDiarizationStream = null;
    }
    meetingDiarizationPath = null;
    meetingDiarizationStartedAt = null;
    meetingMicDiarizationPath = null;
    meetingMicDiarizationStartedAt = null;
    meetingSystemAudioHeard = false;
    meetingSystemAudioDegraded = false;
    meetingDiarizationSegments = [];
    const { pcmPath, startedAt, diarizedSource, cleanupPcmPaths } = resolveDiarizationInput({
      systemPcmPath,
      micPcmPath,
      systemAudioHeard,
      systemStartedAt,
      micStartedAt,
    });
    for (const stalePath of cleanupPcmPaths) {
      fs.unlink(stalePath, () => {});
    }
    return {
      diarizationPcmPath: pcmPath,
      diarizationSegments,
      diarizationStartedAt: startedAt,
      diarizedSource,
    };
  };

  // ---- streaming state and handlers -------------------------------------------

  let meetingMicStreaming: MeetingStreamingClient | null = null;
  let meetingSystemStreaming: MeetingStreamingClient | null = null;

  const attachMeetingStreamingHandlers = (
    streaming: MeetingStreamingClient,
    win: CoordinatorWindowLike | null,
    source: MeetingAudioSource
  ) => {
    const send = (channel: string, data: unknown) => {
      if (!win || win.isDestroyed()) {
        debugLogger.error("Meeting segment send failed: window unavailable", {
          channel,
          source,
          winExists: !!win,
        });
        return;
      }
      win.webContents.send(channel, data);
    };

    streaming.onPartialTranscript = (text) => {
      if (source === "mic" && meetingEchoLeakDetector.isMicProbablyRenderBleed()) {
        send("meeting-transcription-segment", { text: "", source, type: "partial" });
        return;
      }

      send("meeting-transcription-segment", { text, source, type: "partial" });
    };
    streaming.onFinalTranscript = (text, timestamp) => {
      const segments = streaming.completedSegments;
      const latestSegment = segments.length > 0 ? segments[segments.length - 1] : text;
      let micSuppression: MicSegmentSuppression | null = null;
      if (source === "mic") {
        micSuppression = shouldSuppressMicTranscriptSegment(timestamp, Date.now());
        if (micSuppression.suppress) {
          debugLogger.debug("Suppressing contaminated mic segment", {
            reason: micSuppression.reason,
            averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
            averageResidual: micSuppression.averageResidual?.toFixed(3),
            text: latestSegment.slice(0, 80),
          });
          send("meeting-transcription-segment", { text: "", source, type: "partial" });
          return;
        }

        if (shouldSkipDuplicateMicSegment(latestSegment, timestamp, micSuppression)) {
          debugLogger.debug("Skipping duplicate mic segment that matches recent system audio", {
            text: latestSegment.slice(0, 80),
            averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
            averageResidual: micSuppression.averageResidual?.toFixed(3),
          });
          send("meeting-transcription-segment", { text: "", source, type: "partial" });
          return;
        }
      }

      if (source === "system") {
        const pending = removePendingMicFinalsFor(latestSegment, timestamp);
        if (pending.length > 0) {
          debugLogger.debug("Dropping buffered mic segments after system transcript arrived", {
            count: pending.length,
            text: latestSegment.slice(0, 80),
          });
        }

        const retracted = removeRacingMicEntriesFor(latestSegment, timestamp);
        for (const stale of retracted) {
          send("meeting-transcription-segment", {
            text: stale.text,
            source: "mic",
            type: "retract",
            timestamp: stale.timestamp,
          });
        }
      }

      debugLogger.debug("Meeting segment sending to renderer", {
        source,
        text: latestSegment.slice(0, 80),
        segmentCount: segments.length,
        micCorrelation: micSuppression?.averageCorrelation?.toFixed(3),
        micSuppressionReason: micSuppression?.reason,
        micHasBleedEvidence: micSuppression?.hasBleedEvidence,
        micLikelyRenderBleed: micSuppression?.likelyRenderBleed,
        systemSpeaking: micSuppression?.systemSpeaking,
      });
      if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
        debugLogger.debug("Buffering risky mic segment before renderer commit", {
          text: latestSegment.slice(0, 80),
          holdbackMs: STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS,
          reason: micSuppression?.reason,
          hasBleedEvidence: micSuppression?.hasBleedEvidence,
        });
        send("meeting-transcription-segment", { text: "", source, type: "partial" });
        queuePendingMicFinal({
          text: latestSegment,
          timestamp,
          micSuppression,
          holdbackMs: STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS,
          emit: () =>
            sendMeetingFinalSegment({
              text: latestSegment,
              source,
              timestamp,
              micSuppression,
              send,
            }),
        });
        return;
      }

      sendMeetingFinalSegment({
        text: latestSegment,
        source,
        timestamp,
        micSuppression,
        send,
      });
    };
    streaming.onError = (error) => {
      send("meeting-transcription-error", error.message);
    };
    const recoverConnection = async (error: Error, restoreOldOnFailure: boolean) => {
      let recovered = false;
      try {
        recovered = await reconnectMeetingStreams({ restoreOldOnFailure });
      } catch (reconnectError) {
        debugLogger.error("Meeting stream recovery failed unexpectedly", {
          error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
        });
      }
      if (!recovered && !meetingFatalErrorSent) {
        meetingFatalErrorSent = true;
        send(
          "meeting-transcription-fatal-error",
          error?.message || "Meeting transcription connection could not be restored."
        );
      }
    };
    streaming.onConnectionLost = (error) => {
      void recoverConnection(error, false);
    };
    streaming.onSessionExpired = ({ proactive = false } = {}) => {
      void recoverConnection(
        new Error("Meeting transcription session could not be renewed."),
        proactive
      );
    };
  };

  const resetMeetingReconnectAudio = () => {
    meetingReconnectAudioBuffers = { mic: [], system: [] };
    meetingReconnectAudioBytes = { mic: 0, system: 0 };
    meetingReconnectReplaySources = new Set();
  };

  const sendMeetingStreamingAudio = (
    streaming: MeetingStreamingClient,
    buffer: Buffer,
    capturedAt: number | null = null
  ) => {
    const firstSampleAt = streaming.audioBytesSent === 0 ? capturedAt : null;
    const sent = streaming.sendAudio(buffer);
    if (
      sent &&
      streaming.isConnected &&
      firstSampleAt !== null &&
      streaming.sessionStartedAt != null
    ) {
      // Deepgram/Corti time segments from the first PCM sample, which can
      // precede a replacement socket's creation when replaying recovery audio.
      streaming.sessionStartedAt = firstSampleAt;
    }
    return sent;
  };

  const queueMeetingReconnectAudio = (
    source: MeetingAudioSource,
    buffer: Buffer,
    capturedAt: number | null = null
  ) => {
    if (!meetingReconnectReplaySources.has(source)) return;
    const copy = Buffer.from(buffer);
    const queue = meetingReconnectAudioBuffers[source];
    queue.push({ buffer: copy, capturedAt });
    meetingReconnectAudioBytes[source] += copy.length;
    while (
      meetingReconnectAudioBytes[source] > MEETING_RECONNECT_BUFFER_MAX_BYTES &&
      queue.length > 1
    ) {
      meetingReconnectAudioBytes[source] -= queue.shift()!.buffer.length;
    }
  };

  const replayMeetingReconnectAudio = (source: MeetingAudioSource, streaming: MeetingStreamingClient) => {
    if (!meetingReconnectReplaySources.has(source)) return true;
    const queue = meetingReconnectAudioBuffers[source];
    const replayed = queue.every(({ buffer, capturedAt }) =>
      sendMeetingStreamingAudio(streaming, buffer, capturedAt)
    );
    debugLogger.info("Replayed meeting audio after reconnect", {
      source,
      chunks: queue.length,
      bytes: meetingReconnectAudioBytes[source],
    });
    return replayed;
  };

  // Labels the socket for field logs and, for system, swaps in the more
  // sensitive threshold (see MEETING_SYSTEM_VAD_THRESHOLD).
  const withMeetingSourceConnectOpts = (
    connectOpts: Record<string, unknown>,
    source: MeetingAudioSource
  ) => ({
    ...connectOpts,
    streamLabel: source,
    ...(source === "system" ? { vadThreshold: MEETING_SYSTEM_VAD_THRESHOLD } : {}),
  });

  const reconnectMeetingStreams = ({ restoreOldOnFailure = false } = {}) => {
    if (meetingReconnectPromise) return meetingReconnectPromise;

    const pending = (async () => {
      if (meetingLocalMode) return false;

      const options = meetingConnectionOptions;
      const win = meetingConnectionWin;
      if (!options || !win || win.isDestroyed()) {
        debugLogger.error("Cannot reconnect meeting streams: missing connection context");
        return false;
      }

      if (meetingReconnectCount >= MAX_MEETING_RECONNECTS) {
        debugLogger.error("Meeting reconnect limit reached", { count: meetingReconnectCount });
        return false;
      }

      meetingReconnectCount++;

      const oldMic = meetingMicStreaming;
      const oldSystem = meetingSystemStreaming;
      meetingReconnectReplaySources = new Set([
        ...(!oldMic?.isConnected ? (["mic"] as MeetingAudioSource[]) : []),
        ...(oldSystem && !oldSystem.isConnected ? (["system"] as MeetingAudioSource[]) : []),
      ]);
      let newMic: MeetingStreamingClient | null = null;
      let newSystem: MeetingStreamingClient | null = null;

      try {
        const StreamingClass = getMeetingStreamingClient(options.provider as MeetingStreamingProvider);
        newMic = new StreamingClass();
        attachMeetingStreamingHandlers(newMic, win, "mic");
        if (oldSystem) {
          newSystem = new StreamingClass();
          attachMeetingStreamingHandlers(newSystem, win, "system");
        }

        debugLogger.info("Reconnecting meeting streams", {
          attempt: meetingReconnectCount,
          maxAttempts: MAX_MEETING_RECONNECTS,
        });

        const tokenEvent = { sender: win.webContents as WebContents };
        const connectOpts = {
          model: options.model,
          language: options.language,
          mode: options.mode,
          preconfigured: options.mode !== "byok",
          environment: options.environment,
          tenant: options.tenant,
          keyterms: options.keyterms,
          sampleRate: MEETING_STREAM_SAMPLE_RATE,
        };

        let pairs: Array<{ streaming: MeetingStreamingClient; secret: string; source: MeetingAudioSource }>;
        if (newSystem) {
          const secrets = await deps.fetchRealtimeToken(tokenEvent, options, { streams: 2 });
          pairs = [
            { streaming: newMic, secret: secrets[0], source: "mic" },
            { streaming: newSystem, secret: secrets[1], source: "system" },
          ];
        } else {
          pairs = [
            {
              streaming: newMic,
              secret: await deps.fetchRealtimeToken(tokenEvent, options),
              source: "mic",
            },
          ];
        }

        await Promise.all(
          pairs.map(({ streaming, secret, source }) =>
            streaming.connect({
              apiKey: secret,
              token: secret,
              ...withMeetingSourceConnectOpts(connectOpts, source),
            })
          )
        );

        if (pairs.some(({ streaming }) => !streaming.isConnected)) {
          throw new Error("Meeting transcription connection closed during reconnect.");
        }

        if (meetingConnectionOptions !== options) {
          for (const { streaming } of pairs) streaming.disconnect().catch(() => {});
          oldMic?.disconnect().catch(() => {});
          oldSystem?.disconnect().catch(() => {});
          resetMeetingReconnectAudio();
          return true;
        }

        const replayedMic = replayMeetingReconnectAudio("mic", newMic);
        const replayedSystem = !newSystem || replayMeetingReconnectAudio("system", newSystem);
        if (!replayedMic || !replayedSystem) {
          throw new Error("Meeting audio could not be restored after reconnect.");
        }
        meetingMicStreaming = newMic;
        meetingSystemStreaming = newSystem;
        resetMeetingReconnectAudio();
        oldMic?.disconnect().catch(() => {});
        oldSystem?.disconnect().catch(() => {});
        meetingConnectionKey = getMeetingConnectionKey(options);

        debugLogger.info("Meeting streams reconnected", { attempt: meetingReconnectCount });
        meetingReconnectCount = 0;
        return true;
      } catch (error) {
        debugLogger.error("Meeting stream reconnect failed", {
          error: error instanceof Error ? error.message : String(error),
          attempt: meetingReconnectCount,
        });
        newMic?.disconnect().catch(() => {});
        newSystem?.disconnect().catch(() => {});
        if (meetingConnectionOptions !== options) {
          oldMic?.disconnect().catch(() => {});
          oldSystem?.disconnect().catch(() => {});
          resetMeetingReconnectAudio();
          return true;
        }

        const canRestoreOld =
          restoreOldOnFailure && !!oldMic?.isConnected && (!oldSystem || oldSystem.isConnected);
        if (canRestoreOld) {
          meetingMicStreaming = oldMic;
          meetingSystemStreaming = oldSystem;
        } else {
          oldMic?.disconnect().catch(() => {});
          oldSystem?.disconnect().catch(() => {});
          meetingMicStreaming = null;
          meetingSystemStreaming = null;
          meetingConnectionKey = null;
        }
        resetMeetingReconnectAudio();
        if (!win.isDestroyed()) {
          win.webContents.send("meeting-transcription-error", (error as Error).message);
        }
        return canRestoreOld;
      }
    })();

    meetingReconnectPromise = pending;
    return pending.finally(() => {
      if (meetingReconnectPromise === pending) meetingReconnectPromise = null;
    });
  };

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

  const hasNativeMeetingSystemAudio = () => getMeetingSystemAudioMode() === "native";

  const isMeetingStreamingConnected = (systemAudioMode = getMeetingSystemAudioCapabilityMode()) =>
    !!meetingMicStreaming?.isConnected &&
    (systemAudioMode === "unsupported" || !!meetingSystemStreaming?.isConnected);

  const connectRealtimeStreaming = async (
    event: { sender: WebContents },
    options: MeetingConnectionOptions,
    signal?: AbortSignal
  ) => {
    signal?.throwIfAborted();
    const connectionKey = getMeetingConnectionKey(options);
    // Callers validate the provider against ALLOWED_MEETING_PROVIDERS first;
    // the registry lookup fails closed for anything left.
    const StreamingClass = getMeetingStreamingClient(options.provider as MeetingStreamingProvider);
    if (meetingMicStreaming?.isConnected) {
      await meetingMicStreaming.disconnect();
    }
    if (meetingSystemStreaming?.isConnected) {
      await meetingSystemStreaming.disconnect();
    }
    meetingMicStreaming = null;
    meetingSystemStreaming = null;
    const win = BrowserWindow.fromWebContents(event.sender);

    const connectOpts = {
      model: options.model,
      language: options.language,
      mode: options.mode,
      preconfigured: options.mode !== "byok",
      environment: options.environment,
      tenant: options.tenant,
      keyterms: options.keyterms,
      sampleRate: MEETING_STREAM_SAMPLE_RATE,
    };
    const { mode: systemAudioMode } = await getMeetingSystemAudioPlan();
    let pairs: Array<{
      field: "mic" | "system";
      secret: string;
      source: MeetingAudioSource;
    }>;
    if (systemAudioMode !== "unsupported") {
      const secrets = await deps.fetchRealtimeToken(event, options, { streams: 2 });
      pairs = [
        { field: "mic", secret: secrets[0], source: "mic" },
        { field: "system", secret: secrets[1], source: "system" },
      ];
    } else {
      pairs = [
        {
          field: "mic",
          secret: await deps.fetchRealtimeToken(event, options),
          source: "mic",
        },
      ];
    }

    signal?.throwIfAborted();
    const instances: Record<"mic" | "system", MeetingStreamingClient | null> = {
      mic: null,
      system: null,
    };
    for (const { field, source } of pairs) {
      instances[field] = new StreamingClass();
      attachMeetingStreamingHandlers(instances[field]!, win, source);
    }

    try {
      const connections = await Promise.allSettled(
        pairs.map(({ field, secret, source }) =>
          instances[field]!.connect({
            apiKey: secret,
            token: secret,
            ...withMeetingSourceConnectOpts(connectOpts, source),
          })
        )
      );
      signal?.throwIfAborted();
      for (const connection of connections) {
        if (connection.status === "rejected") throw connection.reason;
      }
      if (pairs.some(({ field }) => !instances[field]?.isConnected)) {
        throw new Error("Meeting transcription connection closed during startup.");
      }
      meetingMicStreaming = instances.mic;
      meetingSystemStreaming = instances.system;
      meetingConnectionKey = connectionKey;
    } catch (error) {
      await Promise.all(
        (["mic", "system"] as const).map((field) =>
          instances[field]?.disconnect().catch(() => ({ text: "" }))
        )
      );
      meetingMicStreaming = null;
      meetingSystemStreaming = null;
      meetingConnectionKey = null;
      throw error;
    }

    return win;
  };

  // ---- timers, watchdog, diarization capture and local-mode state -------------

  let meetingSystemAudioSilenceTimer: NodeJS.Timeout | null = null;
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
  let meetingStartedAt: number | null = null;
  let meetingReconnectPromise: Promise<boolean> | null = null;
  let meetingFatalErrorSent = false;
  let meetingReconnectCount = 0;
  let meetingConnectionOptions: MeetingConnectionOptions | null = null;
  let meetingConnectionWin: (BrowserWindow | CoordinatorWindowLike) | null = null;
  let meetingConnectionKey: string | null = null;
  let meetingReconnectAudioBuffers: Record<MeetingAudioSource, ReconnectAudioEntry[]> = {
    mic: [],
    system: [],
  };
  let meetingReconnectAudioBytes: Record<MeetingAudioSource, number> = { mic: 0, system: 0 };
  let meetingReconnectReplaySources = new Set<MeetingAudioSource>();

  let meetingDiarizationStream: fs.WriteStream | null = null;
  let meetingDiarizationPath: string | null = null;
  let meetingDiarizationStartedAt: number | null = null;
  // Parallel raw mic capture so an in-person session (no audible system
  // audio) can be diarized; dropped as soon as the session proves to be a call.
  let meetingMicDiarizationStream: fs.WriteStream | null = null;
  let meetingMicDiarizationPath: string | null = null;
  let meetingMicDiarizationStartedAt: number | null = null;
  let meetingSystemAudioHeard = false;
  let meetingSystemAudioDegraded = false;
  let meetingLiveSpeakerActive = false;
  let meetingLiveSpeakerState: Record<string, unknown> | null = null;
  let meetingLiveSpeakerStartedAt: number | null = null;
  let meetingReclusterTimer: NodeJS.Timeout | null = null;

  let meetingLocalMode = false;
  let meetingLocalBuffers: Record<MeetingAudioSource, Buffer[]> = { mic: [], system: [] };
  let meetingLocalTimer: NodeJS.Timeout | null = null;
  let meetingLocalWin: (BrowserWindow | CoordinatorWindowLike) | null = null;
  let meetingLocalTranscript = "";
  let meetingLocalProvider: string | null = null;
  let meetingLocalModel: string | null = null;
  let meetingLocalLanguage: string | null = null;
  let meetingLocalTranscribing = false;
  let meetingOneOnOneAttendee: { displayName: string; email: string | null } | null = null;
  let meetingOneOnOneProfileBound = false;
  let meetingNoteId: number | null = null;

  const getLiveSpeakerProfiles = () => {
    const attendees = getNoteNonSelfParticipants(publicationDeps, meetingNoteId);
    const attendeeEmails = new Set<string>();
    for (const p of attendees) {
      const email = (p.email || "").toLowerCase().trim();
      if (email) attendeeEmails.add(email);
    }
    if (attendeeEmails.size === 0) return [];
    return databaseManager
      .getSpeakerProfiles(true)
      .filter((p) => p.email && attendeeEmails.has(p.email.toLowerCase()));
  };

  const shouldSuppressMicTranscriptSegment = (startedAt: number, endedAt: number = Date.now()) =>
    meetingEchoLeakDetector.shouldSuppressMicSegment(startedAt, endedAt);

  const resolveOneOnOneAttendeeForNote = (noteId: number | null) => {
    if (!noteId) return null;
    try {
      const note = databaseManager.getNote(noteId);
      return resolveOneOnOneOtherParticipant(publicationDeps, note?.participants);
    } catch {
      return null;
    }
  };

  const resolveDiarizationEnabled = () =>
    (activeMeetingSpeakerConfig?.enabled ?? speakerDiarizationEnabled) !== false;

  const resolveSessionMaxSpeakers = () => {
    const count = activeMeetingSpeakerConfig?.expectedCount;
    const total = count ? Math.min(count, MAX_SPEAKER_COUNT) : DEFAULT_EXPECTED_SPEAKER_COUNT;
    return Math.max(1, total - 1);
  };

  const bindOneOnOneAttendeeToSpeaker = (speakerId: string) => {
    if (!meetingOneOnOneAttendee || meetingOneOnOneProfileBound || !speakerId) return;
    if (!resolveDiarizationEnabled()) return;
    const embedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
    if (!embedding) return;
    try {
      const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      const profile = databaseManager.upsertSpeakerProfile(
        meetingOneOnOneAttendee.displayName,
        meetingOneOnOneAttendee.email,
        buffer
      );
      liveSpeakerIdentifier.mapSpeaker(speakerId, profile.id, meetingOneOnOneAttendee.displayName, null);
      meetingOneOnOneProfileBound = true;
    } catch (error) {
      debugLogger.warn(
        "1-on-1 attendee profile binding failed",
        { error: error instanceof Error ? error.message : String(error) },
        "speaker"
      );
    }
  };

  const stopLiveSpeakerIdentification = async () => {
    if (!meetingLiveSpeakerActive) {
      return null;
    }

    if (meetingReclusterTimer) {
      clearInterval(meetingReclusterTimer);
      meetingReclusterTimer = null;
    }

    meetingLiveSpeakerActive = false;
    meetingLiveSpeakerState = await liveSpeakerIdentifier.stop();
    return meetingLiveSpeakerState;
  };

  const startLiveSpeakerIdentification = async (
    win: CoordinatorWindowLike | null,
    systemAudioMode: string
  ) => {
    await stopLiveSpeakerIdentification();

    if (!supportsLiveSpeakerIdentification(systemAudioMode) || !liveSpeakerIdentifier.isAvailable()) {
      return false;
    }

    const diarizationEnabled = resolveDiarizationEnabled();
    if (!diarizationEnabled) {
      return false;
    }

    meetingLiveSpeakerState = null;
    // Anchored on the first system chunk instead, in sendMeetingAudio.
    meetingLiveSpeakerStartedAt = null;
    const started = await liveSpeakerIdentifier
      .start(
        (identification) => {
          if (!win || win.isDestroyed() || meetingLiveSpeakerStartedAt == null) {
            return;
          }

          bindOneOnOneAttendeeToSpeaker(identification.speakerId);

          const displayName = meetingOneOnOneAttendee
            ? meetingOneOnOneAttendee.displayName
            : identification.displayName;

          const startTime = Math.max(
            meetingLiveSpeakerStartedAt,
            meetingLiveSpeakerStartedAt + identification.startTime * 1000
          );
          const endTime = Math.max(
            startTime,
            meetingLiveSpeakerStartedAt + identification.endTime * 1000
          );
          const enrichedIdentification = {
            ...identification,
            displayName,
            startTime,
            endTime,
          };

          win.webContents.send("meeting-speaker-identified", enrichedIdentification);

          for (const seg of meetingDiarizationSegments) {
            if (
              seg.source === "system" &&
              seg.timestamp != null &&
              seg.timestamp >= startTime &&
              seg.timestamp <= endTime &&
              (!seg.speaker || seg.speakerIsPlaceholder)
            ) {
              // Live identification outranks a placeholder label.
              seg.speaker = identification.speakerId;
              seg.speakerName = displayName || seg.speakerName;
              seg.speakerIsPlaceholder = false;
            }
          }
        },
        {
          getSpeakerProfiles: getLiveSpeakerProfiles,
          maxSpeakers: resolveSessionMaxSpeakers(),
          enabled: true,
        }
      )
      .catch((error) => {
        // isAvailable() only stats the model file, so a corrupt model or an
        // onnxruntime binding that won't load still throws here. Speaker labels
        // are an enhancement — never let them take the recording down with them.
        debugLogger.warn(
          "Live speaker identification start failed",
          { error: error instanceof Error ? error.message : String(error) },
          "speaker"
        );
        return false;
      });

    if (started) {
      meetingLiveSpeakerActive = true;
      meetingReclusterTimer = setInterval(async () => {
        if (!meetingLiveSpeakerActive || !win || win.isDestroyed()) return;

        const merges = await liveSpeakerIdentifier.recluster();
        if (!merges.length) return;

        for (const { keep, remove, displayName } of merges) {
          for (const seg of meetingDiarizationSegments) {
            if (seg.speaker === remove) {
              seg.speaker = keep;
              if (displayName) seg.speakerName = displayName;
            }
          }
        }

        win.webContents.send("meeting-speakers-merged", merges);
      }, 30_000);
    } else {
      meetingLiveSpeakerStartedAt = null;
    }

    return started;
  };

  const transcribeLocalMeetingChunk = async (source: MeetingAudioSource) => {
    const chunks = meetingLocalBuffers[source];
    if (!chunks.length) return;

    const pcm24k = Buffer.concat(chunks);
    meetingLocalBuffers[source] = [];

    const pcm16k = downsample24kTo16k(pcm24k);

    const { rms, peak, sampleCount } = computeChunkStats(pcm16k);
    const verdict = resolveMicChunkAction({
      mode: "local",
      source,
      rms,
      peak,
      sampleCount,
      isSystemSpeaking: () =>
        meetingEchoLeakDetector.isSystemSpeaking(Date.now() - LOCAL_MEETING_CHUNK_INTERVAL_MS),
    });
    if (verdict.action === "skip") {
      debugLogger.debug(
        verdict.reason === "silence"
          ? "Skipping silent meeting chunk"
          : "Skipping system-dominant mic chunk",
        {
          source,
          rms: rms.toFixed(4),
          peak: peak.toFixed(4),
        }
      );
      return;
    }

    const wav = pcm16ToWav(pcm16k);

    try {
      let result: { success?: boolean; text?: string | null } | null | undefined;
      if (isSherpaLocalProvider(meetingLocalProvider)) {
        result = (await parakeetManager.transcribeLocalParakeet(wav, {
          model: meetingLocalModel,
          language: meetingLocalLanguage,
        })) as { success?: boolean; text?: string | null } | null | undefined;
      } else {
        const vadOptions = deps.resolveWhisperVadOptions("meeting");
        result = (await whisperManager.transcribeLocalWhisper(wav, {
          model: meetingLocalModel,
          language: meetingLocalLanguage,
          // Keep whisper.cpp's default decoder thresholds on this continuous
          // load: the raised #1458 values multiply temperature-fallback
          // re-decodes, and meeting chunks already have RMS-gate, VAD, and
          // holdback/dedup hallucination protection.
          skipDecoderThresholds: true,
          ...vadOptions,
        })) as { success?: boolean; text?: string | null } | null | undefined;
      }

      if (result?.success && result.text?.trim()) {
        const text = result.text.trim();
        const segTimestamp = Date.now();
        let micSuppression: MicSegmentSuppression | null = null;
        if (source === "mic") {
          const chunkDurationMs = (pcm24k.length / 2 / 24000) * 1000;
          micSuppression = shouldSuppressMicTranscriptSegment(
            segTimestamp - chunkDurationMs,
            segTimestamp
          );
          debugLogger.debug("Local meeting transcription candidate", {
            source,
            text: text.slice(0, 80),
            suppress: micSuppression.suppress,
            reason: micSuppression.reason,
            hasBleedEvidence: micSuppression.hasBleedEvidence,
            likelyRenderBleed: micSuppression.likelyRenderBleed,
            averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
            averageResidual: micSuppression.averageResidual?.toFixed(3),
          });
          if (micSuppression.suppress) {
            debugLogger.debug("Suppressing contaminated local mic segment", {
              reason: micSuppression.reason,
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
              text: text.slice(0, 80),
            });
            return;
          }

          if (shouldSkipDuplicateMicSegment(text, segTimestamp, micSuppression)) {
            debugLogger.debug("Skipping duplicate local mic segment that matches system audio", {
              text: text.slice(0, 80),
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
            });
            return;
          }
        } else {
          debugLogger.debug("Local meeting transcription candidate", {
            source,
            text: text.slice(0, 80),
          });
        }

        if (source === "system") {
          const pending = removePendingMicFinalsFor(text, segTimestamp);
          if (pending.length > 0) {
            debugLogger.debug(
              "Dropping buffered local mic segments after system transcript arrived",
              {
                count: pending.length,
                text: text.slice(0, 80),
              }
            );
          }

          const retracted = removeRacingMicEntriesFor(text, segTimestamp);
          for (const stale of retracted) {
            if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
              meetingLocalWin.webContents.send("meeting-transcription-segment", {
                text: stale.text,
                source: "mic",
                type: "retract",
                timestamp: stale.timestamp,
              });
            }
          }
        }

        const sendLocalSegment = (channel: string, payload: unknown) => {
          if (channel !== "meeting-transcription-segment") {
            return;
          }

          if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
            meetingLocalWin.webContents.send(channel, payload);
          }
        };

        if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
          debugLogger.debug("Buffering risky local mic segment before renderer commit", {
            text: text.slice(0, 80),
            holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
            reason: micSuppression?.reason,
            hasBleedEvidence: micSuppression?.hasBleedEvidence,
          });
          queuePendingMicFinal({
            text,
            timestamp: segTimestamp,
            micSuppression,
            holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
            emit: () =>
              sendMeetingFinalSegment({
                text,
                source,
                timestamp: segTimestamp,
                micSuppression,
                send: sendLocalSegment,
                includeInLocalTranscript: true,
              }),
          });
          return;
        }

        sendMeetingFinalSegment({
          text,
          source,
          timestamp: segTimestamp,
          micSuppression,
          send: sendLocalSegment,
          includeInLocalTranscript: true,
        });
      }
    } catch (error) {
      debugLogger.error("Local meeting transcription chunk failed", {
        source,
        error: error instanceof Error ? error.message : String(error),
      });
      if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
        meetingLocalWin.webContents.send(
          "meeting-transcription-error",
          (error as Error).message
        );
      }
    }
  };

  const transcribeAllLocalBuffers = async () => {
    if (meetingLocalTranscribing) return;
    meetingLocalTranscribing = true;
    try {
      await transcribeLocalMeetingChunk("system");
      await transcribeLocalMeetingChunk("mic");
    } finally {
      meetingLocalTranscribing = false;
    }
  };

  const dropMeetingMicDiarizationCapture = () => {
    if (meetingMicDiarizationStream) {
      meetingMicDiarizationStream.end();
      meetingMicDiarizationStream = null;
    }
    if (meetingMicDiarizationPath) {
      fs.unlink(meetingMicDiarizationPath, () => {});
      meetingMicDiarizationPath = null;
    }
    meetingMicDiarizationStartedAt = null;
  };

  const resetMeetingLocalState = () => {
    if (meetingLocalTimer) {
      clearInterval(meetingLocalTimer);
      meetingLocalTimer = null;
    }
    if (meetingReclusterTimer) {
      clearInterval(meetingReclusterTimer);
      meetingReclusterTimer = null;
    }
    void stopLiveSpeakerIdentification();
    meetingLiveSpeakerState = null;
    meetingLiveSpeakerStartedAt = null;
    meetingOneOnOneAttendee = null;
    meetingOneOnOneProfileBound = false;
    meetingNoteId = null;
    activeMeetingNoteId = null;
    meetingLocalMode = false;
    meetingLocalBuffers = { mic: [], system: [] };
    if (meetingDiarizationStream) {
      meetingDiarizationStream.end();
      meetingDiarizationStream = null;
    }
    if (meetingDiarizationPath) {
      fs.unlink(meetingDiarizationPath, () => {});
      meetingDiarizationPath = null;
    }
    meetingDiarizationStartedAt = null;
    dropMeetingMicDiarizationCapture();
    meetingSystemAudioHeard = false;
    meetingSystemAudioDegraded = false;
    meetingDiarizationSegments = [];
    meetingLocalWin = null;
    meetingLocalTranscript = "";
    meetingLocalProvider = null;
    meetingLocalModel = null;
    meetingLocalLanguage = null;
    meetingLocalTranscribing = false;
    resetPendingMicFinals();
    meetingStartedAt = null;
    meetingEchoLeakDetector.reset();
  };

  const resetMeetingStreamingState = () => {
    meetingMicStreaming = null;
    meetingSystemStreaming = null;
    meetingLiveSpeakerStartedAt = null;
    resetPendingMicFinals();
    meetingEchoLeakDetector.reset();
    meetingReconnectPromise = null;
    meetingFatalErrorSent = false;
    meetingReconnectCount = 0;
    meetingConnectionOptions = null;
    meetingConnectionWin = null;
    meetingConnectionKey = null;
    resetMeetingReconnectAudio();
  };

  const disconnectMeetingStreaming = async ({ flushPending = false } = {}) => {
    const results = await Promise.all([
      meetingMicStreaming
        ? meetingMicStreaming.disconnect().catch(() => ({ text: "" }))
        : Promise.resolve({ text: "" }),
      meetingSystemStreaming
        ? meetingSystemStreaming.disconnect().catch(() => ({ text: "" }))
        : Promise.resolve({ text: "" }),
    ]);
    if (flushPending) flushPendingMicFinals(true);
    resetMeetingStreamingState();
    return results;
  };

  const clearMeetingSystemAudioSilenceTimer = () => {
    if (meetingSystemAudioSilenceTimer) {
      clearTimeout(meetingSystemAudioSilenceTimer);
      meetingSystemAudioSilenceTimer = null;
    }
  };

  const armMeetingSystemAudioSilenceTimer = (
    win: CoordinatorWindowLike | null,
    systemAudioStrategy: string
  ) => {
    clearMeetingSystemAudioSilenceTimer();
    meetingSystemAudioSilenceTimer = setTimeout(() => {
      meetingSystemAudioSilenceTimer = null;
      if (meetingSystemAudioHeard) return;
      debugLogger.debug(
        "Meeting system audio still silent past warning window",
        { systemAudioStrategy, timeoutMs: MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS },
        "meeting"
      );
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-system-audio-silent", { systemAudioStrategy });
      }
    }, MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS);
  };

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

  const rollbackMeetingTranscriptionStart = async () => {
    clearMeetingSystemAudioSilenceTimer();
    stopMeetingSystemAudioWatchdog();
    if (audioTapManager) await audioTapManager.stop().catch(() => {});
    await stopLiveSpeakerIdentification().catch(() => {});
    resetMeetingLocalState();
    await disconnectMeetingStreaming().catch(() => {});
    activeMeetingSpeakerConfig = null;
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

  const startMeetingTranscription = async (
    event: { sender: WebContents },
    options: Record<string, unknown> = {}
  ) => {
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
    meetingStartedAt = startedAt.getTime();
    meetingNoteId = noteId;
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
      activeCaptureSession = null;
      activeCaptureSessionId = null;
      activeCaptureOwner = null;
      platformMuted = false;
      companionServer?.broadcastSnapshot();
      deps.onCaptureStopped?.();
      deps.setMeetingCaptureState?.(false);
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
    clearMeetingSystemAudioSilenceTimer();
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
      activeCaptureSession = null;
      activeCaptureSessionId = null;
      activeCaptureOwner = null;
      deps.onCaptureStopped?.();
      companionServer?.broadcastSnapshot();
      linkRecordingSessionToNote(null);
      deps.setMeetingCaptureState?.(false);
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
      activeCaptureSession = null;
      activeCaptureSessionId = null;
      activeCaptureOwner = null;
      deps.onCaptureStopped?.();
      companionServer?.broadcastSnapshot();
      linkRecordingSessionToNote(null);
      deps.setMeetingCaptureState?.(false);
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
    const parsed = meetingOptionsSchema.safeParse(options);
    if (!parsed.success) return meetingFailure(new Error("Meeting capture start request is invalid"));
    const sessionId =
      typeof parsed.data.sessionId === "string" && parsed.data.sessionId.length > 0
        ? parsed.data.sessionId
        : crypto.randomUUID();
    return meetingTranscriptionLifecycle.startSession({
      sessionId,
      ownerWebContents: event.sender,
      options: parsed.data,
    });
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

  ipcMain.handle("meeting-set-speaker-diarization-enabled", async (_event, payload?: { enabled?: boolean }) => {
    try {
      speakerDiarizationEnabled = payload?.enabled !== false;
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
        liveSpeakerIdentifier.setEnabled(enabled);
        // Live identification only labels other speakers (the mic track is "you"),
        // so cap at expectedCount - 1 to match resolveSessionMaxSpeakers().
        liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
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

  return {
    isRecording: () => activeCaptureSession !== null,
    startCompanion: () => {
      companionStarted ??= (async () => {
        await companionServer?.start();
        if (companionServer) { companionTicker = setInterval(() => companion.tick(), 1000); companionTicker.unref(); }
      })();
      return companionStarted;
    },
    setCompanionEnabled: (enabled) => companion.setEnabled(enabled),
    disposeCompanion: async () => { if (companionTicker) clearInterval(companionTicker); await companionStarted?.catch(() => {}); if (companionTicker) clearInterval(companionTicker); await companionServer?.stop(); },
    requestSafeStop,
    currentRecordingScope,
    linkRecordingSessionToNote,
    refreshMeetingSpeakerConfigFromNote(noteId, note) {
      const config = activeMeetingSpeakerConfig;
      if (!config || config.explicit) return;
      if (noteId == null || activeMeetingNoteId !== noteId) return;

      const expectedCount = noteExpectedSpeakerCountOrNull(publicationDeps, note);
      if (expectedCount == null || expectedCount <= config.expectedCount) return;

      activeMeetingSpeakerConfig = { ...config, expectedCount };
      liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
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
      resolveOneOnOneOtherParticipant(publicationDeps, participantsJson),
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
