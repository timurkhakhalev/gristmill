import { runInBackground } from "../../stores/noteStore";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeTelegramUsername } from "../../contracts/contactIdentity";
import type { ContactProfile, ContactUpdateInput } from "../../contracts/speakerProfiles";
import { refreshPersonProfile } from "../../hooks/usePersonProfile";
import { Mail, Send } from "../icons";

interface Props {
  contact: ContactProfile;
  /** The name the card shows; the stored name can be empty when it comes from invites or speakers. */
  displayName?: string;
  onSaved: (contact: ContactProfile) => Promise<boolean>;
  onCancel: () => void;
}

const FIELD_CLASS =
  "flex items-center gap-2.5 rounded-md border border-border px-3 text-muted focus-within:border-ring/60";

const INPUT_CLASS =
  "min-w-0 flex-1 appearance-none border-none bg-transparent px-0 py-2 text-xs text-foreground shadow-none outline-none ring-0 placeholder:text-muted focus:ring-0";

/** Compact editor for the name, email and Telegram of one saved contact. */
export default function ContactDetailsForm({ contact, displayName, onSaved, onCancel }: Props) {
  const { t } = useTranslation();

  const [draft, setDraft] = useState({
    displayName: displayName ?? contact.display_name ?? "",
    email: contact.email ?? "",
    telegramUsername: contact.telegram_username ?? "",
  });

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const submit = async () => {
    if (pending.current) return;
    setError(null);
    let input: ContactUpdateInput;

    try {
      input = {
        displayName: draft.displayName.trim() || null,
        email: draft.email.trim().toLowerCase() || null,
        telegramUsername: normalizeTelegramUsername(draft.telegramUsername),
      };
    } catch {
      setError(t("notes.participants.invalidTelegram"));

      return;
    }

    pending.current = true;
    setBusy(true);

    try {
      const result = await window.electronAPI.updateContact(contact.id, input);

      if (!result.success) {
        setError(
          t(
            `notes.participants.${result.error === "email_conflict" ? "editEmailConflict" : result.error === "telegram_conflict" ? "telegramConflict" : result.error === "invalid_telegram" ? "invalidTelegram" : "contactSaveFailed"}`
          )
        );

        return;
      }

      refreshPersonProfile(result.contact);
      await onSaved(result.contact);
    } catch {
      setError(t("notes.participants.contactSaveFailed"));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-2.5 text-xs"
      aria-label={t("notes.participants.editContact")}
      onSubmit={(event) => {
        event.preventDefault();
        runInBackground(submit(), "Contact save failed");
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();

          if (!pending.current) onCancel();
        }
      }}
    >
      <input
        dir="auto"
        autoFocus
        disabled={busy}
        aria-label={t("notes.participants.contactName")}
        placeholder={t("notes.participants.contactName")}
        value={draft.displayName}
        onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
        className="w-full appearance-none rounded-md border border-border bg-transparent px-3 py-2 text-sm font-medium text-foreground shadow-none outline-none ring-0 placeholder:text-muted focus:border-ring/60 focus:ring-0"
      />
      <label className={FIELD_CLASS}>
        <Mail size={14} className="shrink-0" />
        <input
          dir="ltr"
          type="email"
          disabled={busy}
          aria-label={t("notes.participants.optionalEmail")}
          placeholder={t("notes.participants.optionalEmail")}
          value={draft.email}
          onChange={(event) => setDraft({ ...draft, email: event.target.value })}
          className={INPUT_CLASS}
        />
      </label>
      <label className={FIELD_CLASS}>
        <Send size={14} className="shrink-0" />
        <input
          dir="ltr"
          disabled={busy}
          aria-label={t("notes.participants.optionalTelegram")}
          placeholder={t("notes.participants.telegramPlaceholder")}
          value={draft.telegramUsername}
          onChange={(event) => setDraft({ ...draft, telegramUsername: event.target.value })}
          className={INPUT_CLASS}
        />
      </label>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-muted transition-colors hover:text-foreground"
        >
          {t("notes.speaker.cancel")}
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-accent px-3 py-1.5 text-accent-foreground"
        >
          {t(busy ? "notes.participants.saving" : "notes.speaker.save")}
        </button>
      </div>
    </form>
  );
}
