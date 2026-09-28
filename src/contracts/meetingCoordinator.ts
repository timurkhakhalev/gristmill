// Single source of truth for the meeting coordinator boundary: recording
// prepare/start/send/stop/cancel, system-audio availability, recording locks,
// the mic warm hold, detection preferences, session speaker configuration,
// notification respond/ready/data, auto-end completed/respond/restart,
// calendar meeting join, pending meeting-note navigation, and the
// register-meeting-hotkey handler. Channel names, argument order, results and
// errors are unchanged from the previous JS registrations in ipcHandlers.js /
// main.js. sessionId, noteId and detectionId are distinct fields and are never
// interchangeable.
import { z } from "zod";
import type { MeetingProcessingConfig, MeetingProcessingConfigError, MeetingSource } from "./meetingRecording.js";

// ---- channels -----------------------------------------------------------------

export const meetingCoordinatorChannels = {
  meetingTranscriptionPrepare: "meeting-transcription-prepare",
  meetingTranscriptionStart: "meeting-transcription-start",
  meetingTranscriptionSend: "meeting-transcription-send",
  meetingTranscriptionStop: "meeting-transcription-stop",
  meetingTranscriptionCancel: "meeting-transcription-cancel",
  meetingTranscriptionSetSystemAudioAvailable: "meeting-transcription-set-system-audio-available",
  acquireRecordingLock: "acquire-recording-lock",
  releaseRecordingLock: "release-recording-lock",
  micWarmHoldChanged: "mic-warm-hold-changed",
  meetingDetectionGetPreferences: "meeting-detection-get-preferences",
  meetingDetectionSetPreferences: "meeting-detection-set-preferences",
  setSpeakerDiarizationEnabled: "meeting-set-speaker-diarization-enabled",
  setMeetingSessionSpeakerConfig: "meeting-set-session-speaker-config",
  meetingNotificationRespond: "meeting-notification-respond",
  meetingAutoEndCompleted: "meeting-auto-end-completed",
  meetingAutoEndRespond: "meeting-auto-end-respond",
  joinCalendarMeeting: "join-calendar-meeting",
  findCalendarEventNote: "find-calendar-event-note",
  createCalendarEventNote: "create-calendar-event-note",
  getMeetingNotificationData: "get-meeting-notification-data",
  getPendingMeetingNoteNavigation: "get-pending-meeting-note-navigation",
  meetingNotificationReady: "meeting-notification-ready",
  registerMeetingHotkey: "register-meeting-hotkey",
} as const;

export const meetingCoordinatorEventChannels = {
  meetingTranscriptionStopRequested: "meeting-transcription-stop-requested",
  meetingTranscriptionSegment: "meeting-transcription-segment",
  meetingTranscriptionError: "meeting-transcription-error",
  meetingTranscriptionFatalError: "meeting-transcription-fatal-error",
  meetingSpeakerIdentified: "meeting-speaker-identified",
  meetingSpeakersMerged: "meeting-speakers-merged",
  meetingSessionSpeakerConfigUpdated: "meeting-session-speaker-config-updated",
  meetingDiarizationComplete: "meeting-diarization-complete",
  meetingSystemAudioSilent: "meeting-system-audio-silent",
  // Legacy listener with no main-side producer; kept because the renderer
  // still subscribes and the bridge contract owns the full event surface.
  meetingSystemAudioDegraded: "meeting-system-audio-degraded",
  meetingSystemAudioInterrupted: "meeting-system-audio-interrupted",
  meetingSystemAudioResumed: "meeting-system-audio-resumed",
  meetingAutoEndRequested: "meeting-auto-end-requested",
  meetingAutoEndRestartRequested: "meeting-auto-end-restart-requested",
  meetingNotificationData: "meeting-notification-data",
  meetingNoteNavigationPending: "meeting-note-navigation-pending",
} as const;

// ---- shared payload types ------------------------------------------------------

export type MeetingSystemAudioStrategy =
  | "native"
  | "loopback"
  | "pipewire-loopback"
  | "wasapi-loopback"
  | "unsupported";

export interface PolicyFailureMetadata {
  error?: string;
  code?: string;
  status?: number;
  minAppVersion?: string;
  details?: unknown;
}

/** Why auto-end concluded the meeting is over. */
export type MeetingAutoEndReason = "mic-released" | "silence" | "process-exit";

export type MeetingPromptVariant = "detected" | "starting" | "underway";

export interface MeetingDetectionNotificationData {
  kind: "detection";
  detectionId: string;
  source: string;
  key: string;
  event: { summary?: string | null } | null;
  variant: MeetingPromptVariant;
  joinUrl: string | null;
}

export interface MeetingAutoEndNotificationData {
  kind: "auto-end";
  sessionId: string;
  expiresAt: number;
  reason?: MeetingAutoEndReason;
}

export type MeetingNotificationData =
  | MeetingDetectionNotificationData
  | MeetingAutoEndNotificationData;

export interface MeetingAutoEndRequest {
  sessionId: string;
  reason?: MeetingAutoEndReason;
}

export type MeetingAutoEndAction = "restart" | "dismiss";

export interface MeetingAutoEndRestartRequest {
  sessionId: string;
}

export interface MeetingAutoEndLifecycleResult {
  success: boolean;
  reason?: "invalid-session" | "invalid-action" | "stale-session";
  error?: string;
}

export interface MeetingSystemAudioInterruption {
  systemAudioStrategy: MeetingSystemAudioStrategy;
  reason: "no_audio_delivered" | "device_invalidated" | "gone_quiet";
  recovering: boolean;
}

export interface MeetingOneOnOneAttendee {
  displayName: string;
  email: string | null;
}

// ---- wire schemas (renderer side is untrusted, results are untrusted) ---------

const failureMetadataSchema = z
  .object({
    error: z.string().optional(),
    code: z.string().optional(),
    messageKey: z.string().optional(),
  })
  .passthrough();

export const meetingOptionsSchema = z
  .object({
    sessionId: z.string().optional(),
    noteId: z.number().int().nullable().optional(),
    autoEndEligible: z.boolean().optional(),
    recordingConfig: z.unknown().optional(),
  });

// Renderer-facing option shapes (previous electron.ts declarations).
export interface MeetingTranscriptionPrepareOptions {
  noteId?: number | null;
}
export interface MeetingTranscriptionStartOptions {
  noteId?: number | null;
  sessionId: string;
  groupId?: string;
  autoEndEligible: boolean;
  recordingConfig?: {
    config: MeetingProcessingConfig | null;
    configError?: MeetingProcessingConfigError | null;
  };
}

export interface MeetingCapturePacket {
  epochIndex: number;
  epochStartFrame: number;
  sequence: number;
  sampleOffset: number;
}

export const meetingCapturePacketSchema = z.object({
  epochIndex: z.number().int().nonnegative(),
  epochStartFrame: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  sampleOffset: z.number().int().nonnegative(),
});

export interface MeetingCaptureStopRequest {
  sessionId: string;
  lastSequence: Partial<Record<MeetingSource, number>>;
  incomplete?: boolean;
  errorCode?: string;
  suppressProcessing?: boolean;
}

export const meetingCaptureStopRequestSchema = z.object({
  sessionId: z.string().min(1),
  lastSequence: z.object({
    mic: z.number().int().optional(),
    system: z.number().int().optional(),
  }),
  incomplete: z.boolean().optional(),
  errorCode: z.string().optional(),
  suppressProcessing: z.boolean().optional(),
});

// ipcMain.handle keeps only the message when a promise rejects, so failures
// resolve with serialized error shapes instead of throwing.
export const meetingPrepareResultSchema = failureMetadataSchema.extend({
  success: z.boolean(),
  alreadyPrepared: z.boolean().optional(),
});
export type MeetingPrepareResult = z.infer<typeof meetingPrepareResultSchema>;

export const meetingStartResultSchema = failureMetadataSchema.extend({
  success: z.boolean(),
  sessionId: z.string().optional(),
  recordingId: z.string().uuid().optional(),
  originAt: z.string().optional(),
  systemAudioMode: z.enum(["native", "loopback", "portal", "unsupported"]).optional(),
  systemAudioStrategy: z
    .enum(["native", "loopback", "pipewire-loopback", "wasapi-loopback", "unsupported"])
    .optional(),
  oneOnOneAttendee: z
    .object({ displayName: z.string(), email: z.string().nullable() })
    .nullable()
    .optional(),
});
export type MeetingStartResult = z.infer<typeof meetingStartResultSchema>;

export const meetingStopResultSchema = z
  .object({
    success: z.boolean(),
    recordingId: z.string().uuid().optional(),
    initialRunId: z.string().uuid().optional(),
    captureState: z.enum(["ready", "incomplete"]).optional(),
    errorCode: z.string().nullable().optional(),
    error: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();
export type MeetingStopResult = z.infer<typeof meetingStopResultSchema>;

export const meetingCaptureAckSchema = z.object({ success: z.boolean(), sequence: z.number().int().nonnegative() });
export type MeetingCaptureAck = z.infer<typeof meetingCaptureAckSchema>;

export const meetingCancelResultSchema = z.object({
  success: z.boolean(),
  reason: z.literal("recording-active").optional(),
});
export type MeetingCancelResult = z.infer<typeof meetingCancelResultSchema>;

export const meetingSetSystemAudioAvailableResultSchema = z.object({
  success: z.boolean(),
  reason: z.literal("stale-session").optional(),
});
export type MeetingSetSystemAudioAvailableResult = z.infer<
  typeof meetingSetSystemAudioAvailableResultSchema
>;

export const recordingLockResultSchema = z
  .object({
    success: z.boolean(),
    holder: z.string().optional(),
  })
  .passthrough();
export type RecordingLockResult = z.infer<typeof recordingLockResultSchema>;

export const meetingDetectionPreferencesSchema = z
  .object({
    processDetection: z.boolean(),
    audioDetection: z.boolean(),
  })
  .passthrough();
export type MeetingDetectionPreferences = z.infer<typeof meetingDetectionPreferencesSchema>;

export const meetingDetectionGetPreferencesResultSchema = z.union([
  z.object({ success: z.literal(true), preferences: meetingDetectionPreferencesSchema }),
  z.object({ success: z.literal(false), error: z.string() }),
]);
export type MeetingDetectionGetPreferencesResult = z.infer<
  typeof meetingDetectionGetPreferencesResultSchema
>;

export const simpleSuccessResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
  })
  .passthrough();
export type SimpleSuccessResult = z.infer<typeof simpleSuccessResultSchema>;

/** The note linked to a calendar event; null when there is none (or it could not be created). */
export const calendarEventNoteResultSchema = z
  .object({ noteId: z.number().int().positive(), folderId: z.number().int().positive().nullable() })
  .nullable();
export type CalendarEventNoteResult = z.infer<typeof calendarEventNoteResultSchema>;

export const meetingAutoEndLifecycleResultSchema = z.object({
  success: z.boolean(),
  reason: z.enum(["invalid-session", "invalid-action", "stale-session"]).optional(),
  error: z.string().optional(),
});

export const meetingNotificationDataSchema = z.union([
  z.object({
    kind: z.literal("detection"),
    detectionId: z.string(),
    source: z.string(),
    key: z.string(),
    event: z.union([
      z.object({ summary: z.string().nullable() }),
      z.null(),
    ]),
    variant: z.enum(["detected", "starting", "underway"]),
    joinUrl: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("auto-end"),
    sessionId: z.string(),
    expiresAt: z.number(),
    reason: z.enum(["mic-released", "silence", "process-exit"]).optional(),
  }),
]);

export const meetingNotificationRespondResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
  })
  .passthrough();

export const pendingMeetingNoteNavigationSchema = z
  .object({
    noteId: z.number(),
    folderId: z.number(),
    event: z.unknown().optional(),
    trigger: z.string().optional(),
  })
  .passthrough();
export type PendingMeetingNoteNavigation = z.infer<typeof pendingMeetingNoteNavigationSchema>;

export const registerMeetingHotkeyResultSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});
export type RegisterMeetingHotkeyResult = z.infer<typeof registerMeetingHotkeyResultSchema>;

// ---- event payload schemas ------------------------------------------------------

export const meetingSegmentEventSchema = z
  .object({
    text: z.string(),
    source: z.enum(["mic", "system"]),
    type: z.enum(["partial", "final", "retract"]),
    timestamp: z.number().optional(),
  })
  .passthrough();
export type MeetingSegmentEvent = z.infer<typeof meetingSegmentEventSchema>;

export const meetingSpeakerIdentifiedEventSchema = z
  .object({
    speakerId: z.string(),
    displayName: z.string().nullable().optional(),
    startTime: z.number(),
    endTime: z.number(),
  })
  .passthrough();
export type MeetingSpeakerIdentifiedEvent = z.infer<typeof meetingSpeakerIdentifiedEventSchema>;

export const meetingSpeakersMergedEventSchema = z.array(
  z
    .object({
      keep: z.string(),
      remove: z.string(),
      displayName: z.string().nullable().optional(),
      similarity: z.number(),
    })
    .passthrough()
);
export type MeetingSpeakersMergedEvent = z.infer<typeof meetingSpeakersMergedEventSchema>;

export const meetingSessionSpeakerConfigEventSchema = z.object({
  enabled: z.boolean(),
  expectedCount: z.number(),
});

export const meetingTranscriptSegmentSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    source: z.enum(["mic", "system"]),
    timestamp: z.number().optional(),
    speaker: z.string().optional(),
    speakerName: z.string().optional(),
    speakerIsPlaceholder: z.boolean().optional(),
    suggestedName: z.string().optional(),
    suggestedProfileId: z.number().optional(),
    speakerStatus: z.enum(["provisional", "confirmed", "suggested", "locked"]).optional(),
    speakerLocked: z.boolean().optional(),
    speakerLockSource: z.enum(["user", "diarization", "suggestion"]).optional(),
  })
  .passthrough();
export type MeetingTranscriptSegment = z.infer<typeof meetingTranscriptSegmentSchema>;

export const meetingDiarizationCompleteEventSchema = z.object({
  sessionId: z.string().optional(),
  noteId: z.number().nullable().optional(),
  segments: z.array(meetingTranscriptSegmentSchema),
  speakerEmbeddings: z.record(z.string(), z.array(z.number())).nullable().optional(),
});
export type MeetingDiarizationCompleteEvent = z.infer<typeof meetingDiarizationCompleteEventSchema>;

export const meetingSystemAudioSilentEventSchema = z.object({
  systemAudioStrategy: z.enum([
    "native",
    "loopback",
    "pipewire-loopback",
    "wasapi-loopback",
    "unsupported",
  ]),
});

export const meetingSystemAudioInterruptedEventSchema = z.object({
  systemAudioStrategy: z.enum([
    "native",
    "loopback",
    "pipewire-loopback",
    "wasapi-loopback",
    "unsupported",
  ]),
  reason: z.enum(["no_audio_delivered", "device_invalidated", "gone_quiet"]),
  recovering: z.boolean(),
});

export const meetingAutoEndRequestEventSchema = z.object({
  sessionId: z.string(),
  reason: z.enum(["mic-released", "silence", "process-exit"]).optional(),
});

export const meetingStopRequestedEventSchema = z.object({
  sessionId: z.string().min(1),
  suppressProcessing: z.boolean().optional(),
});

export const meetingAutoEndRestartRequestEventSchema = z.object({
  sessionId: z.string(),
});

// ---- renderer-facing surface ------------------------------------------------------

export interface MeetingCoordinatorApi {
  meetingTranscriptionPrepare?(
    options?: MeetingTranscriptionPrepareOptions
  ): Promise<MeetingPrepareResult>;
  meetingTranscriptionStart?(
    options: MeetingTranscriptionStartOptions
  ): Promise<MeetingStartResult>;
  meetingTranscriptionSend?(
    buffer: ArrayBuffer,
    source: MeetingSource,
    sessionId: string,
    packet: MeetingCapturePacket
  ): Promise<MeetingCaptureAck>;
  meetingTranscriptionStop?(request?: MeetingCaptureStopRequest): Promise<MeetingStopResult>;
  meetingTranscriptionCancel?(): Promise<MeetingCancelResult>;
  meetingTranscriptionSetSystemAudioAvailable?(
    sessionId: string,
    available: boolean
  ): Promise<MeetingSetSystemAudioAvailableResult>;
  acquireRecordingLock?(pipeline: string): Promise<RecordingLockResult>;
  releaseRecordingLock?(pipeline: string): Promise<RecordingLockResult>;
  meetingDetectionGetPreferences?(): Promise<MeetingDetectionGetPreferencesResult>;
  meetingDetectionSetPreferences?(
    prefs: Record<string, boolean>
  ): Promise<SimpleSuccessResult>;
  setSpeakerDiarizationEnabled?(enabled: boolean): Promise<SimpleSuccessResult>;
  setMeetingSessionSpeakerConfig?(config: {
    enabled: boolean;
    expectedCount: number;
    countIsExplicit?: boolean;
  }): Promise<SimpleSuccessResult>;
  meetingNotificationRespond?(
    detectionId: string,
    action: string
  ): Promise<{ success: boolean; error?: string }>;
  meetingAutoEndCompleted?(sessionId: string): Promise<MeetingAutoEndLifecycleResult>;
  meetingAutoEndRespond?(
    sessionId: string,
    action: MeetingAutoEndAction
  ): Promise<MeetingAutoEndLifecycleResult>;
  joinCalendarMeeting?(eventId: string): Promise<SimpleSuccessResult>;
  findCalendarEventNote?(eventId: string): Promise<CalendarEventNoteResult>;
  createCalendarEventNote?(
    eventId: string,
    initial: { title?: string; content?: string }
  ): Promise<CalendarEventNoteResult>;
  getMeetingNotificationData?(): Promise<MeetingNotificationData | null>;
  getPendingMeetingNoteNavigation?(): Promise<PendingMeetingNoteNavigation | null>;
  meetingNotificationReady?(): Promise<unknown>;
  registerMeetingHotkey?(hotkey: string): Promise<RegisterMeetingHotkeyResult>;
  onMeetingTranscriptionSegment?(
    callback: (data: MeetingSegmentEvent) => void
  ): () => void;
  onMeetingTranscriptionStopRequested?(callback: (request: z.infer<typeof meetingStopRequestedEventSchema>) => void): () => void;
  onMeetingSpeakerIdentified?(
    callback: (data: MeetingSpeakerIdentifiedEvent) => void
  ): () => void;
  onMeetingSpeakersMerged?(callback: (merges: MeetingSpeakersMergedEvent) => void): () => void;
  onMeetingSessionSpeakerConfigUpdated?(
    callback: (config: { enabled: boolean; expectedCount: number }) => void
  ): () => void;
  onMeetingDiarizationComplete?(
    callback: (data: MeetingDiarizationCompleteEvent) => void
  ): () => void;
  onMeetingTranscriptionError?(callback: (error: string) => void): () => void;
  onMeetingTranscriptionFatalError?(callback: (error: string) => void): () => void;
  onMeetingSystemAudioSilent?(
    callback: (data: { systemAudioStrategy: string }) => void
  ): () => void;
  onMeetingSystemAudioDegraded?(callback: () => void): () => void;
  onMeetingSystemAudioInterrupted?(
    callback: (data: MeetingSystemAudioInterruption) => void
  ): () => void;
  onMeetingSystemAudioResumed?(callback: () => void): () => void;
  onMeetingNotificationData?(
    callback: (data: MeetingNotificationData) => void
  ): () => void;
  onMeetingAutoEndRequested?(callback: (request: MeetingAutoEndRequest) => void): () => void;
  onMeetingAutoEndRestartRequested?(
    callback: (request: MeetingAutoEndRestartRequest) => void
  ): () => void;
  onMeetingNoteNavigationPending?(callback: () => void): () => void;
}
