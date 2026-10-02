import { meetingPlatformLabel } from "../../contracts/meetingRecording";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CompanionCandidate, CompanionStatus } from "../../contracts/companion";
import {
  getActiveRecordingSessionId,
  useMeetingRecordingStore,
} from "../../stores/meetingRecordingStore";

export function MeetBindingControl() {
  const { t } = useTranslation();
  const recordingId = useMeetingRecordingStore((s) => s.recordingId);
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const update = (value: CompanionStatus) => {
      if (active) setStatus(value);
    };
    const unsubscribe = window.electronAPI?.onMeetCompanionStatus?.(update);
    void window.electronAPI
      ?.getMeetCompanionStatus?.()
      .then(update)
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  if (!isRecording || !recordingId || !status?.enabled) return null;
  const bind = async (candidate: CompanionCandidate) => {
    const sessionId = getActiveRecordingSessionId();
    if (!sessionId) return;
    setBusy(true);
    setFailed(false);
    try {
      setFailed(
        !(
          await window.electronAPI?.confirmMeetCompanionBinding?.({
            expected: { recordingId, sessionId },
            candidate: { connectionId: candidate.connectionId, ref: candidate.ref },
          })
        )?.success
      );
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const candidates = status.candidates.filter(
    (candidate) =>
      !status.binding ||
      candidate.connectionId !== status.binding.connectionId ||
      candidate.ref.documentId !== status.binding.ref.documentId ||
      candidate.ref.platform !== status.binding.ref.platform ||
      candidate.ref.callId !== status.binding.ref.callId
  );
  return (
    <div className="mb-3 min-w-0 space-y-1 break-words text-xs text-muted-foreground">
      {status.binding ? (
        <p>
          {t(
            status.contextReason?.endsWith("ui-unrecognized")
              ? "meetIntegration.uiUnrecognized"
              : status.contextUnavailableSince !== null
                ? "meetIntegration.contextLost"
                : "meetIntegration.bound",
            { call: `${meetingPlatformLabel(status.binding.ref.platform)} ${status.binding.ref.callId}` }
          )}
        </p>
      ) : null}
      {(!status.binding || candidates.length > 0) && (
        <>
          <p>
            {t(candidates.length ? "meetIntegration.confirmDescription" : "meetIntegration.noCall")}
          </p>
          <div className="flex flex-wrap gap-2">
            {candidates.map((candidate, index) => (
              <button
                type="button"
                disabled={busy}
                className="rounded border border-foreground/15 px-2 py-1 hover:bg-foreground/5 disabled:opacity-40"
                key={`${candidate.connectionId}/${candidate.ref.documentId}`}
                onClick={() => void bind(candidate)}
              >
                {t("meetIntegration.bind", { call: `${meetingPlatformLabel(candidate.ref.platform)} ${candidate.ref.callId}` })} · {index + 1}
                {candidate.context.mode === "companion"
                  ? ` · ${t("meetIntegration.companionMode")}`
                  : ""}
              </button>
            ))}
          </div>
        </>
      )}
      {failed && (
        <p role="alert" className="text-danger">
          {t("meetIntegration.staleSelection")}
        </p>
      )}
    </div>
  );
}
