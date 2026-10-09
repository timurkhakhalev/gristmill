import { useEffect, useState } from "react";
import {
  getMicAnalyser,
  getSystemAudioLevel,
  setManualMicMuted,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";
import { useSettingsStore } from "../stores/settingsStore";
import { INACTIVE_MEETING_COMPANION_STATE } from "../contracts/meetingCompanion";

// Timers, not rAF: the control panel is usually minimized or hidden exactly
// when the companion is on screen, and rAF stops for hidden documents.
const LEVEL_INTERVAL_MS = 100;

const LEVEL_SMOOTHING = 0.5;

/** Mirrors the meeting recording into the main-process companion bubble. */
export function useMeetingCompanionSync(): void {
  const [levelNeeded, setLevelNeeded] = useState(false);
  useEffect(() => window.electronAPI?.onMeetingCompanionLevelDemand?.(setLevelNeeded), []);
  const enabled = useSettingsStore((s) => s.meetingCompanionEnabled);
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const capturePhase = useMeetingRecordingStore((s) => s.capturePhase);
  const noteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const folderId = useMeetingRecordingStore((s) => s.recordingFolderId);
  const title = useMeetingRecordingStore((s) => s.recordingNoteTitle);
  const micCaptureStatus = useMeetingRecordingStore((s) => s.micCaptureStatus);
  const manualMicMuted = useMeetingRecordingStore((s) => s.manualMicMuted);
  const platformMicMuted = useMeetingRecordingStore((s) => s.platformMicMuted);

  const paused = capturePhase === "paused";
  const active = enabled && (isRecording || paused);
  const micMuted = manualMicMuted || platformMicMuted;
  const waitingForMic = micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable";

  useEffect(() => {
    window.electronAPI?.updateMeetingCompanion?.(
      active
        ? { active, paused, waitingForMic, micMuted, noteId, folderId, title: title ?? "" }
        : INACTIVE_MEETING_COMPANION_STATE
    );
  }, [active, paused, waitingForMic, micMuted, noteId, folderId, title]);

  useEffect(
    () =>
      window.electronAPI?.onMeetingCompanionToggleMic?.(() => {
        const { manualMicMuted: muted } = useMeetingRecordingStore.getState();
        void setManualMicMuted(!muted).catch(() => undefined);
      }),
    []
  );

  useEffect(
    () => () => window.electronAPI?.updateMeetingCompanion?.(INACTIVE_MEETING_COMPANION_STATE),
    []
  );

  useEffect(() => {
    if (!active || paused || !levelNeeded) return;
    let smoothed = 0;
    let lastDisplayLevel = -1;
    let buf = new Float32Array(256);

    const timer = setInterval(() => {
      const analyser = getMicAnalyser();
      let micRms = 0;

      if (analyser) {
        if (buf.length !== analyser.fftSize) buf = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        let sumSquares = 0;

        for (let i = 0; i < buf.length; i++) sumSquares += buf[i] * buf[i];
        micRms = Math.sqrt(sumSquares / buf.length);
      }

      // Either side talking moves the bars: the mic is you, system audio is everyone else.
      const rms = Math.max(micRms, getSystemAudioLevel());
      smoothed = LEVEL_SMOOTHING * smoothed + (1 - LEVEL_SMOOTHING) * rms;
      // Quantize by visible bar movement, keeping quiet speech above rest.
      const displayLevel = Math.round(Math.min(1, Math.sqrt(smoothed) * 1.8) * 48);

      if (displayLevel === lastDisplayLevel) return;
      lastDisplayLevel = displayLevel;
      window.electronAPI?.sendMeetingCompanionLevel?.(Math.min(1, smoothed));
    }, LEVEL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      window.electronAPI?.sendMeetingCompanionLevel?.(0);
    };
  }, [active, paused, levelNeeded]);
}
