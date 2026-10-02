import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { MeetingProcessingRecordingResult } from "../contracts/meetingProcessing";

export function useMeetingPlayback({ noteId, recordings, preview = false, previewPlayback, onError }: {
  noteId: number;
  recordings: Array<{ recording: Pick<MeetingProcessingRecordingResult["recording"], "id" | "durationSeconds" | "audioState"> }>;
  preview?: boolean;
  previewPlayback?: { currentTime: number; playing: boolean };
  onError: (message?: string) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const lease = useRef<string | null>(null);
  const generation = useRef(0);
  const cancelMetadata = useRef<(() => void) | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const release = useCallback((id: string | null) => {
    if (id) void window.electronAPI.meetingRecordingReleasePlayback(id).catch(() => {});
  }, []);
  const stop = useCallback((audio = audioRef.current) => {
    generation.current++;
    cancelMetadata.current?.();
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
    release(lease.current);
    lease.current = null;
    setPlayingId(null);
    setIsPlaying(false);
    setPlaybackTime(0);
    setDuration(0);
    setIsSeeking(false);
  }, [release]);

  useEffect(() => {
    // Capture the element: React detaches the ref before unmount effects run.
    const audio = audioRef.current;
    return () => stop(audio);
  }, [noteId, stop]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => { if (!isSeeking) setPlaybackTime(audio.currentTime); };
    const onMeta = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onEnd = () => stop(audio);
    const onMediaError = () => { stop(audio); onError(); };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const listeners = { timeupdate: onTime, loadedmetadata: onMeta, durationchange: onMeta, ended: onEnd, error: onMediaError, play: onPlay, pause: onPause };
    for (const [event, listener] of Object.entries(listeners)) audio.addEventListener(event, listener);
    return () => {
      for (const [event, listener] of Object.entries(listeners)) audio.removeEventListener(event, listener);
    };
  }, [isSeeking, onError, stop]);

  const previewId = recordings[0]?.recording.id;
  useEffect(() => {
    if (!preview || !previewPlayback || !previewId) return;
    setPlayingId(previewId);
    setPlaybackTime(previewPlayback.currentTime);
    setIsPlaying(previewPlayback.playing);
  }, [preview, previewPlayback, previewId]);

  useEffect(() => {
    if (!isPlaying || isSeeking) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (preview) setPlaybackTime(value => value + (now - last) / 1000);
      else if (audioRef.current) setPlaybackTime(audioRef.current.currentTime);
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, isSeeking, preview]);

  const totalDuration = duration > 0 ? duration : recordings.find(item => item.recording.id === playingId)?.recording.durationSeconds ?? 0;
  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const clamped = Math.max(0, Math.min(seconds, totalDuration || seconds));
    if (!preview) audio.currentTime = clamped;
    setPlaybackTime(clamped);
  };
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !playingId) return;
    if (preview) { setIsPlaying(value => !value); return; }
    if (!audio.paused) { audio.pause(); return; }
    const request = generation.current;
    void audio.play().catch(() => {
      if (request !== generation.current) return;
      stop(audio);
      onError();
    });
  };

  const startAudio = async (id: string, seek = 0) => {
    if (playingId === id && audioRef.current && seek === 0) { togglePlay(); return; }
    if (preview) { setPlaybackTime(seek); setPlayingId(id); setIsPlaying(true); return; }
    if (!recordings.some(item => item.recording.id === id && item.recording.audioState === "available")) return;
    if (cancelMetadata.current) stop();
    const request = ++generation.current;
    try {
      const result = await window.electronAPI.meetingRecordingGetPlaybackPath(id);
      const audio = audioRef.current;
      if (request !== generation.current || !audio) { release(result.leaseId ?? null); return; }
      if (!result.success || !result.path) {
        release(result.leaseId ?? null);
        onError(result.error);
        return;
      }
      audio.pause();
      setPlayingId(null);
      release(lease.current);
      lease.current = result.leaseId ?? null;
      const url = new URL(result.path, "file://").href;
      const changed = audio.src !== url;
      setDuration(!changed && Number.isFinite(audio.duration) ? audio.duration : 0);
      if (changed) audio.src = url;
      if (changed || audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>(resolve => {
          const done = () => {
            audio.removeEventListener("loadedmetadata", done);
            audio.removeEventListener("error", done);
            if (cancelMetadata.current === done) cancelMetadata.current = null;
            resolve();
          };
          cancelMetadata.current = done;
          audio.addEventListener("loadedmetadata", done);
          audio.addEventListener("error", done);
          if (changed) audio.load();
        });
      }
      if (request !== generation.current) return;
      audio.currentTime = Math.max(0, Math.min(seek, Number.isFinite(audio.duration) ? audio.duration : seek));
      await audio.play();
      if (request === generation.current) setPlayingId(id);
    } catch (error) {
      if (request !== generation.current) return;
      stop();
      onError(error instanceof Error ? error.message : undefined);
    }
  };

  const onSeekBarPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const bar = seekBarRef.current;
    if (!bar || !audioRef.current) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    setIsSeeking(true);
    seekTo(ratio * totalDuration);
    bar.setPointerCapture(event.pointerId);
  };
  const onSeekBarPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSeeking || !seekBarRef.current || !audioRef.current) return;
    const rect = seekBarRef.current.getBoundingClientRect();
    seekTo(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * totalDuration);
  };
  const onSeekBarPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    setIsSeeking(false);
    seekBarRef.current?.releasePointerCapture(event.pointerId);
  };

  return { audioRef, seekBarRef, playingId, isPlaying, playbackTime, totalDuration,
    startAudio, togglePlay, seekTo, skip: (delta: number) => seekTo(playbackTime + delta), stop,
    onSeekBarPointerDown, onSeekBarPointerMove, onSeekBarPointerUp };
}
