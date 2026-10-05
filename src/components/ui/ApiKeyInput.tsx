import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Check, X, KeyRound } from "../icons";
import { Input } from "./input";
import logger from "../../utils/logger";

interface ApiKeyInputProps {
  apiKey: string;
  setApiKey: (key: string) => unknown | Promise<unknown>;
  className?: string;
  placeholder?: string;
  label?: string;
  ariaLabel?: string;
  helpText?: React.ReactNode;
  variant?: "default" | "purple";
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";

  return key.slice(0, 3) + "..." + key.slice(-4);
}

export default function ApiKeyInput({
  apiKey,
  setApiKey,
  className = "",
  placeholder,
  label,
  ariaLabel,
  helpText,
  variant = "default",
}: ApiKeyInputProps) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t("apiKeyInput.placeholder");
  const resolvedLabel = label ?? t("apiKeyInput.label");
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const saveInFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasKey = apiKey.length > 0;
  const variantClasses = variant === "purple" ? "border-primary focus:border-primary" : "";

  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing]);

  const enterEdit = () => {
    setDraft(apiKey);
    setIsEditing(true);
  };

  const save = useCallback(async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setIsSaving(true);
    setSaveError(false);

    try {
      const result = await setApiKey(draft.trim());

      if (
        !result ||
        typeof result !== "object" ||
        !("success" in result) ||
        result.success !== true
      ) {
        setSaveError(true);

        return;
      }

      setIsEditing(false);
    } catch {
      logger.warn("Failed to save API key securely", {}, "settings");
      setSaveError(true);
    } finally {
      saveInFlight.current = false;
      setIsSaving(false);
    }
  }, [draft, setApiKey]);

  const cancel = () => {
    setDraft("");
    setSaveError(false);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }

    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  // Commit the draft instead of discarding it — users paste a key and click
  // the next field expecting it to stick (Escape or ✕ still cancels).
  useEffect(() => {
    if (!isEditing) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      save();
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isEditing, save]);

  return (
    <div className={className}>
      {resolvedLabel && (
        <label className="mb-1.5 block text-sm font-medium text-foreground">{resolvedLabel}</label>
      )}

      <div ref={containerRef} className="relative">
        {isEditing ? (
          <div dir="ltr" className="relative">
            <Input
              dir="ltr"
              ref={inputRef}
              type="text"
              placeholder={resolvedPlaceholder}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaveError(false);
              }}
              onKeyDown={handleKeyDown}
              aria-label={ariaLabel || resolvedLabel || t("apiKeyInput.label")}
              className={`h-9 rounded-lg text-sm font-mono pr-16 ${variantClasses}`}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => void save()}
                disabled={isSaving}
                className="h-6 w-6 flex items-center justify-center rounded text-success hover:bg-success/10 active:scale-95 transition-all disabled:opacity-50"
                aria-label={t("apiKeyInput.save")}
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={cancel}
                className="h-6 w-6 flex items-center justify-center rounded text-muted hover:text-muted-foreground hover:bg-subtle/50 active:scale-95 transition-all"
                aria-label={t("apiKeyInput.cancelEdit")}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={enterEdit}
            className="group flex h-9 w-full cursor-pointer items-center rounded-lg border border-border bg-field px-3 text-sm outline-none transition-colors hover:border-border-hover focus-visible:ring-2 focus-visible:ring-focus"
            aria-label={hasKey ? t("apiKeyInput.edit") : t("apiKeyInput.add")}
          >
            {hasKey ? (
              <span
                dir="ltr"
                className="flex items-center gap-1.5 text-foreground/70 font-mono text-xs tracking-wide"
              >
                <KeyRound className="w-3 h-3 text-muted shrink-0" />
                {maskKey(apiKey)}
              </span>
            ) : (
              <span className="text-muted-foreground text-sm">{resolvedPlaceholder}</span>
            )}
            <span className="ms-auto text-xs font-medium text-link">
              {hasKey ? t("apiKeyInput.editButton") : t("apiKeyInput.addButton")}
            </span>
          </button>
        )}
        {isEditing && saveError && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {t("apiKeyInput.saveError", {
              defaultValue: "Could not save securely. Check secure storage and try again.",
            })}
          </p>
        )}
      </div>

      {helpText && <p className="text-xs text-muted mt-1">{helpText}</p>}
    </div>
  );
}
