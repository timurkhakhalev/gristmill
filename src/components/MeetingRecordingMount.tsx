import { createElement, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import {
  getActiveRecordingSessionId,
  getMicAnalyser,
  getSystemAudioLevel,
  primeMeetingWorklet,
  startRecording,
  stopRecording,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";
import {
  createMeetingAutoEndRestartContext,
  requestMeetingRecordingAutoEnd,
  runMeetingAutoEndRestart,
  type MeetingAutoEndRestartContext,
} from "../helpers/meetingRecordingSession";
import { parseTranscriptSegments } from "../utils/parseTranscriptSegments";
import logger from "../utils/logger";
import { useMeetingCompanionSync } from "../hooks/useMeetingCompanionSync";

const EMA_PREV = 0.5;
const EMA_NEXT = 0.5;

// Sentinel errors set by meetingRecordingStore, translated at display time.
// A sentinel may carry one argument after a colon, e.g. `unsupportedProvider:groq`.
// Anything that is not a sentinel reaches the toast unchanged.
const MEETING_ERROR_KEYS: Record<string, string> = {
  policyRestricted: "notes.meeting.restrictedByOrg",
  unsupportedSelfHosted: "notes.meeting.unsupportedSelfHosted",
  unsupportedProvider: "notes.meeting.unsupportedProvider",
  noProviderSelected: "notes.meeting.noProviderSelected",
};

export default function MeetingRecordingMount(): null {
  useMeetingCompanionSync();
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const error = useMeetingRecordingStore((s) => s.error);
  const errorNonce = useMeetingRecordingStore((s) => s.errorNonce);
  const systemAudioSilentWarning = useMeetingRecordingStore((s) => s.systemAudioSilentWarning);
  const systemAudioInterrupted = useMeetingRecordingStore((s) => s.systemAudioInterrupted);
  const systemAudioInterruptedNonce = useMeetingRecordingStore(
    (s) => s.systemAudioInterruptedNonce
  );
  const micCaptureStatus = useMeetingRecordingStore((s) => s.micCaptureStatus);
  const wasMicUnavailable = useRef(false);
  const wasSystemAudioSilent = useRef(false);
  const pendingAutoEndRestart = useRef<MeetingAutoEndRestartContext | null>(null);
  // The auto-end listeners are registered once, so they cannot close over `t`
  // or `toast` directly without pinning the language they mounted with.
  const notifyAutoEnded = useRef<() => void>(() => {});
  const notifyRestartFailed = useRef<() => void>(() => {});

  useEffect(() => {
    notifyAutoEnded.current = () => {
      toast({ title: t("notes.meeting.title"), description: t("notes.meeting.autoEnded") });
    };
    notifyRestartFailed.current = () => {
      toast({
        title: t("notes.meeting.title"),
        description: t("notes.meeting.restartFailed"),
        variant: "destructive",
      });
    };
  }, [toast, t]);

  useEffect(() => {
    primeMeetingWorklet();
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onMeetingTranscriptionStopRequested?.((request) => {
      if (request.reason === "platform-leave") return;
      void stopRecording(request.sessionId, { suppressProcessing: request.suppressProcessing === true }).catch((error) => {
        logger.error(
          "Meeting capture could not drain before quit",
          { error: error instanceof Error ? error.message : String(error), sessionId: request.sessionId },
          "meeting"
        );
      });
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const handleAutoEnd = async (request: { sessionId: string }, platformLeave = false) => {
      if (!platformLeave) {
        try {
          if (!(await window.electronAPI?.claimMeetingAutoEnd?.(request.sessionId))?.success) return;
        } catch (error) {
          logger.error("Meeting auto-end claim failed; recording is still running", {
            error: error instanceof Error ? error.message : String(error),
            sessionId: request.sessionId,
          }, "meeting");
          return;
        }
      }
      const restartContext = createMeetingAutoEndRestartContext(
        request.sessionId,
        getActiveRecordingSessionId(),
        useMeetingRecordingStore.getState()
      );
      if (!restartContext) return;

      requestMeetingRecordingAutoEnd(
        request,
        async (sessionId) => {
          const result = await stopRecording(sessionId);
          return { stopped: result.stopped && useMeetingRecordingStore.getState().capturePhase === "saved" };
        },
        (sessionId, stopped) => {
          // Every path that ends the recording without offering a restart card
          // has to say so, or the recording just disappears.
          const abandonRestart = () => {
            if (pendingAutoEndRestart.current?.sessionId === sessionId) {
              pendingAutoEndRestart.current = null;
            }
            notifyAutoEnded.current();
          };

          const completion = window.electronAPI?.meetingAutoEndCompleted;
          if (!stopped || !completion) {
            abandonRestart();
            return;
          }

          pendingAutoEndRestart.current = restartContext;
          void completion(sessionId)
            .then((result) => {
              if (!result.success) abandonRestart();
            })
            .catch((error) => {
              abandonRestart();
              logger.error(
                "Meeting auto-end completion acknowledgment failed",
                { error: error instanceof Error ? error.message : String(error), sessionId },
                "meeting"
              );
            });
        },
        (error, sessionId) => {
          logger.error(
            "Meeting auto-end stop failed; recording is still running",
            { error: error instanceof Error ? error.message : String(error), sessionId },
            "meeting"
          );
        }
      );
    };
    const unsubscribeStop = window.electronAPI?.onMeetingAutoEndRequested?.((request) => handleAutoEnd(request));
    const unsubscribeLeave = window.electronAPI?.onMeetingTranscriptionStopRequested?.((request) => {
      if (request.reason === "platform-leave") handleAutoEnd(request, true);
    });

    const unsubscribeRestart = window.electronAPI?.onMeetingAutoEndRestartRequested?.((request) => {
      const context = pendingAutoEndRestart.current;
      pendingAutoEndRestart.current = null;

      void runMeetingAutoEndRestart(request, context, {
        getActiveSessionId: getActiveRecordingSessionId,
        getLatestSegments: () => useMeetingRecordingStore.getState().segments,
        getNote: (noteId) => window.electronAPI?.getNote?.(noteId) ?? Promise.resolve(null),
        parseSegments: parseTranscriptSegments,
        startRecording,
      })
        .then((outcome) => {
          // Main already closed the card and reported success, so an abort the
          // user is not told about looks exactly like a restart that worked.
          if (outcome.status === "started") return;
          logger.error(
            "Meeting recording restart aborted",
            { reason: outcome.reason, sessionId: request.sessionId },
            "meeting"
          );
          notifyRestartFailed.current();
        })
        .catch((error) => {
          logger.error(
            "Meeting recording restart failed",
            { error: error instanceof Error ? error.message : String(error) },
            "meeting"
          );
          notifyRestartFailed.current();
        });
    });

    return () => {
      unsubscribeStop?.();
      unsubscribeLeave?.();
      unsubscribeRestart?.();
    };
  }, []);

  useEffect(() => {
    if (isRecording) pendingAutoEndRestart.current = null;
  }, [isRecording]);

  useEffect(() => {
    if (!error) return;
    const [sentinel, argument] = error.split(":");
    const errorKey = MEETING_ERROR_KEYS[sentinel];
    const captureErrorCode = useMeetingRecordingStore.getState().captureErrorCode;
    const captureWriteFailed = captureErrorCode === "capture-write-failed"
      || error === "capture-queue-overflow"
      || error === "capture-ack-timeout";
    toast({
      title: t("notes.meeting.title"),
      description: captureWriteFailed
        ? t("notes.meeting.captureError")
        : errorKey ? t(errorKey, { provider: argument }) : error,
      variant: "destructive",
    });
    // errorNonce re-fires this toast when the same error repeats back-to-back.
  }, [error, errorNonce, toast, t]);

  // The store latches this once per recording; the ref keeps dependency
  // changes (e.g. a language switch recreating `t`) from re-firing the toast.
  useEffect(() => {
    if (!systemAudioSilentWarning) {
      wasSystemAudioSilent.current = false;
      return;
    }
    if (wasSystemAudioSilent.current) return;
    wasSystemAudioSilent.current = true;
    toast({
      title: t("notes.meeting.systemAudioSilent.title"),
      description: t("notes.meeting.systemAudioSilent.description"),
      duration: 8000,
    });
  }, [systemAudioSilentWarning, toast, t]);

  useEffect(() => {
    const deliverInterruption = (): void => {
      const state = useMeetingRecordingStore.getState();
      if (!state.isRecording || !state.systemAudioInterrupted) {
        return;
      }
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        state.systemAudioInterruptedDeliveredNonce === state.systemAudioInterruptedNonce
      )
        return;

      const interruption = state.systemAudioInterrupted;
      let key = "notes.meeting.systemAudioStopped";
      if (interruption.recovering) {
        key = "notes.meeting.systemAudioInterrupted";
      } else if (interruption.reason === "gone_quiet") {
        key = "notes.meeting.systemAudioQuiet";
      }
      const sessionId = getActiveRecordingSessionId();
      const toastId = toast({
        title: t(`${key}.title`),
        description: t(`${key}.description`),
        duration: interruption.recovering ? 8000 : 0,
        action:
          key === "notes.meeting.systemAudioStopped" && sessionId
            ? createElement(
                "button",
                {
                  type: "button",
                  className: "text-xs text-primary underline hover:text-primary/80",
                  onClick: async (): Promise<void> => {
                    await stopRecording(sessionId);
                  },
                },
                t("notes.editor.stop")
              )
            : undefined,
      });
      // The provider survives route changes. Keep its warning until the
      // recording stops or a newer interruption supersedes it, even unmounted.
      const unsubscribe = useMeetingRecordingStore.subscribe((next) => {
        if (
          !next.isRecording ||
          !next.systemAudioInterrupted ||
          next.systemAudioInterruptedNonce !== state.systemAudioInterruptedNonce
        ) {
          dismiss(toastId);
          unsubscribe();
        }
      });
      // Keep delivery state outside this component: routes may unmount it
      // while the recording and interruption listener continue running.
      useMeetingRecordingStore.setState({
        systemAudioInterruptedDeliveredNonce: state.systemAudioInterruptedNonce,
      });
    };
    deliverInterruption();
    document.addEventListener("visibilitychange", deliverInterruption);
    window.addEventListener("focus", deliverInterruption);
    return (): void => {
      document.removeEventListener("visibilitychange", deliverInterruption);
      window.removeEventListener("focus", deliverInterruption);
    };
  }, [isRecording, systemAudioInterrupted, systemAudioInterruptedNonce, toast, dismiss, t]);

  useEffect(() => {
    if (micCaptureStatus === "unavailable" && !wasMicUnavailable.current) {
      wasMicUnavailable.current = true;
      toast({
        title: t("hooks.audioRecording.micDisconnected.title"),
        description: t("hooks.audioRecording.micDisconnected.meetingDescription"),
        variant: "default",
      });
    } else if (micCaptureStatus === "active" && wasMicUnavailable.current) {
      wasMicUnavailable.current = false;
      toast({
        title: t("hooks.audioRecording.micRestored.title"),
        description: t("hooks.audioRecording.micRestored.description"),
        variant: "default",
      });
    } else if (micCaptureStatus === "inactive") {
      wasMicUnavailable.current = false;
    }
  }, [micCaptureStatus, toast, t]);

  useEffect(() => {
    if (!isRecording) return;

    let rafId = 0;
    let smoothed = 0;
    let buf = new Float32Array(256);

    const tick = () => {
      const analyser = getMicAnalyser();
      let micRms = 0;
      if (analyser) {
        if (buf.length !== analyser.fftSize) {
          buf = new Float32Array(analyser.fftSize);
        }
        analyser.getFloatTimeDomainData(buf);
        let sumSquares = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sumSquares += v * v;
        }
        micRms = Math.sqrt(sumSquares / buf.length);
      }
      const rms = Math.max(micRms, getSystemAudioLevel());
      smoothed = EMA_PREV * smoothed + EMA_NEXT * rms;
      const clamped = smoothed < 0 ? 0 : smoothed > 1 ? 1 : smoothed;
      useMeetingRecordingStore.setState({ currentAudioLevel: clamped });
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      useMeetingRecordingStore.setState({ currentAudioLevel: 0 });
    };
  }, [isRecording]);

  return null;
}
