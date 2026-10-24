import { runInBackground } from "../../stores/noteStore";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeTelegramUsername } from "../../contracts/contactIdentity";
import type { ContactProfile, ContactUpdateInput } from "../../contracts/speakerProfiles";
import { refreshPersonProfile } from "../../hooks/usePersonProfile";

interface Props {
  contact?: ContactProfile;
  initialName?: string;
  participantIds?: number[];
  onSaved: (contact: ContactProfile) => Promise<boolean>;
  onCancel: () => void;
}

/** One draft and one canonical mutation for both contact entry points. */
export default function ContactDetailsForm({
  contact,
  initialName = "",
  participantIds = [],
  onSaved,
  onCancel,
}: Props) {
  const { t } = useTranslation();

  const [draft, setDraft] = useState({
    displayName: contact?.display_name ?? initialName,
    email: contact?.email ?? "",
    telegramUsername: contact?.telegram_username ?? "",
  });

  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ContactProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const persisted = useRef<ContactProfile | null>(null);

  const attach = async (person: ContactProfile) => {
    if (participantIds.includes(person.id)) {
      setError(t("notes.participants.alreadyAdded"));

      return;
    }

    try {
      if (await onSaved(person)) return;
    } catch {
      /* The contact save has already committed. */
    }

    setExisting(person);
    setError(t("notes.participants.participantSaveFailed"));
  };

  const submit = async () => {
    if (pending.current) return;
    setError(null);
    let input: ContactUpdateInput;

    try {
      if (!contact && !draft.displayName.trim()) {
        setError(t("notes.participants.nameRequired"));

        return;
      }

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
      if (persisted.current) {
        await attach(persisted.current);

        return;
      }

      const result = contact
        ? await window.electronAPI.updateContact(contact.id, input)
        : await window.electronAPI.createContact({
            ...input,
            displayName: draft.displayName.trim(),
          });

      if (!result.success) {
        if (result.error === "email_conflict" && result.existingContactId) {
          const rows = await window.electronAPI.getContactProfiles([result.existingContactId]);
          setExisting(rows[0] ?? null);
        }

        setError(
          t(
            `notes.participants.${result.error === "email_conflict" ? (contact ? "editEmailConflict" : "emailConflict") : result.error === "telegram_conflict" ? "telegramConflict" : result.error === "invalid_telegram" ? "invalidTelegram" : "contactSaveFailed"}`
          )
        );

        return;
      }

      persisted.current = contact ? null : result.contact;
      refreshPersonProfile(result.contact);
      await attach(result.contact);
    } catch {
      setError(t("notes.participants.contactSaveFailed"));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const selectExisting = async () => {
    if (!existing || pending.current) return;
    pending.current = true;
    setBusy(true);

    try {
      await attach(existing);
    } catch {
      setError(t("notes.participants.participantSaveFailed"));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-2 text-xs"
      aria-label={t(
        contact ? "notes.participants.editContact" : "notes.participants.createContact"
      )}
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
      <label className="block">
        {t("notes.participants.contactName")}
        <input
          dir="auto"
          autoFocus
          required={!contact}
          disabled={busy}
          value={draft.displayName}
          onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
          className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5"
        />
      </label>
      <label className="block">
        {t("notes.participants.optionalEmail")}
        <input
          dir="ltr"
          type="email"
          disabled={busy}
          value={draft.email}
          onChange={(event) => setDraft({ ...draft, email: event.target.value })}
          className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5"
        />
      </label>
      <label className="block">
        {t("notes.participants.optionalTelegram")}
        <input
          dir="ltr"
          disabled={busy}
          value={draft.telegramUsername}
          onChange={(event) => setDraft({ ...draft, telegramUsername: event.target.value })}
          className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5"
        />
      </label>
      <p className="text-muted">{t("notes.participants.telegramHint")}</p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {existing && (
        <div className="space-y-1">
          <p>
            {existing.display_name || existing.email} · #{existing.id}
          </p>
          {!contact && (
            <button
              type="button"
              disabled={busy || participantIds.includes(existing.id)}
              onClick={() => {
                runInBackground(selectExisting(), "Participant selection failed");
              }}
              className="text-link"
            >
              {t(
                participantIds.includes(existing.id)
                  ? "notes.participants.alreadyAdded"
                  : "notes.participants.selectExisting"
              )}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setExisting(null);
              setError(null);
            }}
            className="ms-2 text-muted"
          >
            {t("notes.participants.cancelSelection")}
          </button>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel}>
          {t("notes.speaker.cancel")}
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-accent px-3 py-1.5 text-accent-foreground"
        >
          {t(busy ? "notes.participants.saving" : "notes.speaker.save")}
        </button>
      </div>
    </form>
  );
}
