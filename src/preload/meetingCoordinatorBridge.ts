import {
  companionSetupSchema,
  companionStatusSchema,
  companionPlatformMuteSchema,
} from "../contracts/companion.js";
// Renderer-facing meeting coordinator bridge. Moved out of preload.js so the
// recording/detection/auto-end/notification operations and their events have
// one typed implementation backed by the shared contract. Invoke results are
// validated before they reach the renderer; event payloads are validated and
// dropped when malformed. The sandboxed preload can't require local modules,
// so build-main.js bundles the final preload.
import {
  meetingCoordinatorChannels,
  meetingCoordinatorEventChannels,
  meetingPrepareResultSchema,
  meetingStartResultSchema,
  meetingStopResultSchema,
  meetingCancelResultSchema,
  meetingCaptureAckSchema,
  meetingMicIntentResultSchema,
  meetingClockProbeResultSchema,
  meetingSetSystemAudioAvailableResultSchema,
  recordingLockResultSchema,
  meetingDetectionGetPreferencesResultSchema,
  simpleSuccessResultSchema,
  calendarEventNoteResultSchema,
  meetingAutoEndLifecycleResultSchema,
  meetingNotificationDataSchema,
  meetingNotificationRespondResultSchema,
  pendingMeetingNoteNavigationSchema,
  registerMeetingHotkeyResultSchema,
  meetingSegmentEventSchema,
  meetingSpeakerIdentifiedEventSchema,
  meetingSpeakersMergedEventSchema,
  meetingSessionSpeakerConfigEventSchema,
  meetingDiarizationCompleteEventSchema,
  meetingSystemAudioSilentEventSchema,
  meetingSystemAudioInterruptedEventSchema,
  meetingAutoEndRequestEventSchema,
  meetingAutoEndRestartRequestEventSchema,
  meetingStopRequestedEventSchema,
  type MeetingCoordinatorApi,
  type MeetingNotificationData,
} from "../contracts/meetingCoordinator.js";
import type { ZodType } from "zod";

import type { IpcRendererLike } from "./ipcTransport.js";
import { z } from "zod";

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

// Main -> renderer events only reach the callback when the payload parses;
// junk is dropped on the preload boundary. Listeners deliver payload-only.
function subscribe<T>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  schema: ZodType<T> | null,
  deliver: (data: T) => void
): () => void {
  const listener = (_event: unknown, payload: unknown) => {
    if (schema === null) {
      // SAFETY: the schema-less subscription is only used for void pings;
      // undefined is the declared deliverable for those channels.
      deliver(undefined as T);

      return;
    }

    const parsed = schema.safeParse(payload);

    if (parsed.success) {
      deliver(parsed.data);
    }
  };

  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// The return type is the shared MeetingCoordinatorApi, so any drift between
// this implementation and the contract fails compilation.
export function createMeetingCoordinatorBridge(
  ipcRenderer: IpcRendererLike
): MeetingCoordinatorApi {
  const invokeParse = <T>(schema: ZodType<T>, channel: string, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args).then((raw) => parseResult(schema, raw, channel));

  return {
    finishPausedMeetRecording: (recordingId) =>
      invokeParse(
        simpleSuccessResultSchema,
        meetingCoordinatorChannels.finishPausedMeetRecording,
        recordingId
      ),
    getMeetIntegrationSetup: () =>
      invokeParse(companionSetupSchema, meetingCoordinatorChannels.getMeetIntegrationSetup),
    configureMeetIntegration: (action) =>
      invokeParse(
        simpleSuccessResultSchema,
        meetingCoordinatorChannels.configureMeetIntegration,
        action
      ),
    respondMeetContextReminder: (request) =>
      invokeParse(
        simpleSuccessResultSchema,
        meetingCoordinatorChannels.respondMeetContextReminder,
        request
      ),
    claimMeetingAutoEnd: (sessionId) =>
      invokeParse(
        simpleSuccessResultSchema,
        meetingCoordinatorChannels.claimMeetingAutoEnd,
        sessionId
      ),
    getMeetCompanionStatus: () =>
      invokeParse(companionStatusSchema, meetingCoordinatorChannels.getMeetCompanionStatus),
    confirmMeetCompanionBinding: (request) =>
      invokeParse(
        simpleSuccessResultSchema,
        meetingCoordinatorChannels.confirmMeetCompanionBinding,
        request
      ),
    onMeetCompanionStatus: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetCompanionStatus,
        companionStatusSchema,
        callback
      ),
    onMeetManualMute: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetManualMute,
        companionPlatformMuteSchema,
        callback
      ),
    onMeetPlatformMute: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetPlatformMute,
        companionPlatformMuteSchema,
        callback
      ),
    meetingTranscriptionPrepare: (options) =>
      invokeParse(
        meetingPrepareResultSchema,
        meetingCoordinatorChannels.meetingTranscriptionPrepare,
        options
      ),
    meetingTranscriptionStart: (options) =>
      invokeParse(
        meetingStartResultSchema,
        meetingCoordinatorChannels.meetingTranscriptionStart,
        options
      ),
    meetingTranscriptionSend: (buffer, source, sessionId, packet) =>
      invokeParse(
        meetingCaptureAckSchema,
        meetingCoordinatorChannels.meetingTranscriptionSend,
        buffer,
        source,
        sessionId,
        packet
      ),
    meetingTranscriptionSetMicIntent: (request) =>
      invokeParse(
        meetingMicIntentResultSchema,
        meetingCoordinatorChannels.meetingTranscriptionSetMicIntent,
        request
      ),
    meetingTranscriptionProbeClock: (request) =>
      invokeParse(
        meetingClockProbeResultSchema,
        meetingCoordinatorChannels.meetingTranscriptionProbeClock,
        request
      ),
    meetingTranscriptionStop: (request) =>
      invokeParse(
        meetingStopResultSchema,
        meetingCoordinatorChannels.meetingTranscriptionStop,
        request
      ),
    meetingTranscriptionCancel: () =>
      invokeParse(meetingCancelResultSchema, meetingCoordinatorChannels.meetingTranscriptionCancel),
    meetingTranscriptionSetSystemAudioAvailable: (sessionId, available) =>
      invokeParse(
        meetingSetSystemAudioAvailableResultSchema,
        meetingCoordinatorChannels.meetingTranscriptionSetSystemAudioAvailable,
        sessionId,
        available
      ),
    acquireRecordingLock: (pipeline) =>
      invokeParse(
        recordingLockResultSchema,
        meetingCoordinatorChannels.acquireRecordingLock,
        pipeline
      ),
    releaseRecordingLock: (pipeline) =>
      invokeParse(
        recordingLockResultSchema,
        meetingCoordinatorChannels.releaseRecordingLock,
        pipeline
      ),
    meetingDetectionGetPreferences: () =>
      invokeParse(
        meetingDetectionGetPreferencesResultSchema,
        meetingCoordinatorChannels.meetingDetectionGetPreferences
      ),
    meetingDetectionSetPreferences: (prefs) =>
      invokeParse(
        simpleSuccessResultSchema,
        meetingCoordinatorChannels.meetingDetectionSetPreferences,
        prefs
      ),
    setMeetingSessionSpeakerConfig: (config) =>
      invokeParse(
        simpleSuccessResultSchema,
        meetingCoordinatorChannels.setMeetingSessionSpeakerConfig,
        config
      ),
    meetingNotificationRespond: (detectionId, action) =>
      invokeParse(
        meetingNotificationRespondResultSchema,
        meetingCoordinatorChannels.meetingNotificationRespond,
        detectionId,
        action
      ),
    meetingAutoEndCompleted: (sessionId) =>
      invokeParse(
        meetingAutoEndLifecycleResultSchema,
        meetingCoordinatorChannels.meetingAutoEndCompleted,
        sessionId
      ),
    meetingAutoEndRespond: (sessionId, action) =>
      invokeParse(
        meetingAutoEndLifecycleResultSchema,
        meetingCoordinatorChannels.meetingAutoEndRespond,
        sessionId,
        action
      ),
    joinCalendarMeeting: (eventId) =>
      invokeParse(
        simpleSuccessResultSchema,
        meetingCoordinatorChannels.joinCalendarMeeting,
        eventId
      ),
    findCalendarEventNote: (eventId) =>
      invokeParse(
        calendarEventNoteResultSchema,
        meetingCoordinatorChannels.findCalendarEventNote,
        eventId
      ),
    createCalendarEventNote: (eventId, initial) =>
      invokeParse(
        calendarEventNoteResultSchema,
        meetingCoordinatorChannels.createCalendarEventNote,
        eventId,
        initial
      ),
    getMeetingNotificationData: () =>
      // SAFETY: the schema already validated the discriminated DTO; the cast
      // bridges the renderer's strictNullChecks-off view of the null union.
      invokeParse(
        meetingNotificationDataSchema.nullable(),
        meetingCoordinatorChannels.getMeetingNotificationData
      ) as Promise<MeetingNotificationData | null>,
    getPendingMeetingNoteNavigation: () =>
      invokeParse(
        pendingMeetingNoteNavigationSchema.nullable(),
        meetingCoordinatorChannels.getPendingMeetingNoteNavigation
      ),
    meetingNotificationReady: () =>
      ipcRenderer.invoke(meetingCoordinatorChannels.meetingNotificationReady).then(() => undefined),
    registerMeetingHotkey: (hotkey) =>
      invokeParse(
        registerMeetingHotkeyResultSchema,
        meetingCoordinatorChannels.registerMeetingHotkey,
        hotkey
      ),

    onMeetingTranscriptionSegment: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingTranscriptionSegment,
        meetingSegmentEventSchema,
        callback
      ),
    onMeetingTranscriptionStopRequested: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingTranscriptionStopRequested,
        meetingStopRequestedEventSchema,
        callback
      ),
    onMeetingSpeakerIdentified: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingSpeakerIdentified,
        meetingSpeakerIdentifiedEventSchema,
        callback
      ),
    onMeetingSpeakersMerged: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingSpeakersMerged,
        meetingSpeakersMergedEventSchema,
        callback
      ),
    onMeetingDiarizationComplete: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingDiarizationComplete,
        meetingDiarizationCompleteEventSchema,
        callback
      ),
    onMeetingSessionSpeakerConfigUpdated: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingSessionSpeakerConfigUpdated,
        meetingSessionSpeakerConfigEventSchema,
        callback
      ),
    onMeetingTranscriptionError: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingTranscriptionError,
        z.string(),
        callback
      ),
    onMeetingTranscriptionFatalError: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingTranscriptionFatalError,
        z.string(),
        callback
      ),
    onMeetingSystemAudioSilent: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingSystemAudioSilent,
        meetingSystemAudioSilentEventSchema,
        callback
      ),
    onMeetingSystemAudioLevel: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingSystemAudioLevel,
        z.number().min(0).max(1),
        callback
      ),
    // Legacy listener: no main-side producer today, kept for the renderer
    // subscription contract. No payload.
    onMeetingSystemAudioDegraded: (callback) =>
      subscribe(ipcRenderer, meetingCoordinatorEventChannels.meetingSystemAudioDegraded, null, () =>
        callback()
      ),
    onMeetingSystemAudioInterrupted: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingSystemAudioInterrupted,
        meetingSystemAudioInterruptedEventSchema,
        callback
      ),
    onMeetingSystemAudioResumed: (callback) =>
      subscribe(ipcRenderer, meetingCoordinatorEventChannels.meetingSystemAudioResumed, null, () =>
        callback()
      ),
    onMeetingNotificationData: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingNotificationData,
        meetingNotificationDataSchema,
        (data: MeetingNotificationData) => callback(data)
      ),
    onMeetingAutoEndRequested: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingAutoEndRequested,
        meetingAutoEndRequestEventSchema,
        callback
      ),
    onMeetingAutoEndRestartRequested: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingAutoEndRestartRequested,
        meetingAutoEndRestartRequestEventSchema,
        callback
      ),
    onMeetingNoteNavigationPending: (callback) =>
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingNoteNavigationPending,
        null,
        () => callback()
      ),
  };
}
