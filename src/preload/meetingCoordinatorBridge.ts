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
  meetingSetSystemAudioAvailableResultSchema,
  recordingLockResultSchema,
  meetingDetectionGetPreferencesResultSchema,
  simpleSuccessResultSchema,
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
  type MeetingCoordinatorApi,
  type MeetingNotificationData,
} from "../contracts/meetingCoordinator.js";
import type { ZodType } from "zod";
import { z } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

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
    meetingTranscriptionSend: (buffer, source) =>
      ipcRenderer.send(meetingCoordinatorChannels.meetingTranscriptionSend, buffer, source),
    meetingTranscriptionStop: (expectedSessionId) =>
      invokeParse(
        meetingStopResultSchema,
        meetingCoordinatorChannels.meetingTranscriptionStop,
        expectedSessionId
      ),
    meetingTranscriptionCancel: () =>
      invokeParse(
        meetingCancelResultSchema,
        meetingCoordinatorChannels.meetingTranscriptionCancel
      ),
    meetingTranscriptionSetSystemAudioAvailable: (sessionId, available) =>
      invokeParse(
        meetingSetSystemAudioAvailableResultSchema,
        meetingCoordinatorChannels.meetingTranscriptionSetSystemAudioAvailable,
        sessionId,
        available
      ),
    acquireRecordingLock: (pipeline) =>
      invokeParse(recordingLockResultSchema, meetingCoordinatorChannels.acquireRecordingLock, pipeline),
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
    setSpeakerDiarizationEnabled: (enabled) =>
      invokeParse(
        simpleSuccessResultSchema,
        meetingCoordinatorChannels.setSpeakerDiarizationEnabled,
        { enabled }
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
      invokeParse(simpleSuccessResultSchema, meetingCoordinatorChannels.joinCalendarMeeting, eventId),
    getMeetingNotificationData: () =>
      // Validated shape boundary-cast to the shared discriminated DTO: the
      // renderer compiles this file with strictNullChecks off, where the
      // null-union keys of the parsed output no longer line up textually.
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
      ipcRenderer.invoke(meetingCoordinatorChannels.meetingNotificationReady),
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
      subscribe(
        ipcRenderer,
        meetingCoordinatorEventChannels.meetingSystemAudioResumed,
        null,
        () => callback()
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
