import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Share2 } from "../icons";
import { ToastContext } from "../ui/useToast";
import { formatNoteLink, formatNoteShareText } from "../../contracts/noteLink";
import { NOTE_META_CHIP_CLASS } from "./shared";

/** Copies a call link with a short CLI instruction, so an agent can read the call. */
export default function ShareWithAgentChip({ noteId, noteTitle }: { noteId: number; noteTitle: string }) {
  const { t } = useTranslation();
  const toast = useContext(ToastContext)?.toast;
  const [shared, setShared] = useState(false);

  useEffect(() => {
    if (!shared) return;

    const timer = window.setTimeout(() => setShared(false), 1500);

    return () => window.clearTimeout(timer);
  }, [shared]);

  const share = async () => {
    try {
      const protocol = await window.electronAPI.getOAuthProtocol();
      await navigator.clipboard.writeText(
        formatNoteShareText(formatNoteLink(protocol, noteId), noteTitle)
      );
      setShared(true);
    } catch {
      toast?.({
        title: t("meetingResults.copyError", { defaultValue: "Couldn't copy to the clipboard." }),
        variant: "destructive",
      });
    }
  };

  return (
    <button type="button" className={NOTE_META_CHIP_CLASS} onClick={() => void share()}>
      {shared ? (
        <Check size={14} className="shrink-0 text-muted" />
      ) : (
        <Share2 size={14} className="shrink-0 text-muted" />
      )}
      {shared
        ? t("meetingResults.callLinkCopied", { defaultValue: "Link copied" })
        : t("meetingResults.shareWithAgent", { defaultValue: "Share with agent" })}
    </button>
  );
}
