import { useTranslation } from "react-i18next";
import { X } from "../icons";
import { cn } from "../lib/utils";
import { FOLDER_COLOR_HEX } from "./folderColors";

const EMOJI = [
  "📄",
  "📝",
  "📓",
  "📚",
  "📌",
  "⭐",
  "🔥",
  "💡",
  "🎯",
  "🚀",
  "💼",
  "📅",
  "📞",
  "🎙️",
  "👥",
  "🤝",
  "💬",
  "📈",
  "💰",
  "🧾",
  "🛠️",
  "🧪",
  "🔒",
  "🏠",
  "🎨",
  "🎬",
  "🎧",
  "✈️",
  "🌍",
  "❤️",
  "✅",
  "⚠️",
];

/** Curated emoji grid for naming a note or folder; the pick is the stored icon itself. */
export function EmojiIconGrid({
  value,
  onSelect,
  color,
  onColorSelect,
}: {
  value: string | null | undefined;
  onSelect: (icon: string | null) => void;
  /** Folders only: the tint of the default glyph, picked from a fixed palette. */
  color?: string | null;
  onColorSelect?: (color: string | null) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex w-56 flex-col gap-2">
      <div className="grid grid-cols-8 gap-0.5">
        {EMOJI.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={emoji}
            aria-pressed={emoji === value}
            onClick={() => onSelect(emoji)}
            className={cn(
              "flex size-6 items-center justify-center rounded-md text-sm outline-none transition-colors hover:bg-default focus-visible:ring-1 focus-visible:ring-focus",
              emoji === value && "bg-default"
            )}
          >
            {emoji}
          </button>
        ))}
      </div>
      {onColorSelect && (
        <div
          role="group"
          aria-label={t("notes.context.folderColor")}
          className="flex items-center gap-1.5 px-0.5"
        >
          {Object.entries(FOLDER_COLOR_HEX).map(([name, hex]) => (
            <button
              key={name}
              type="button"
              aria-label={name}
              aria-pressed={name === color}
              onClick={() => onColorSelect(name === color ? null : name)}
              style={{ backgroundColor: hex }}
              className={cn(
                "size-4 rounded-full outline-none ring-offset-1 ring-offset-transparent transition-shadow focus-visible:ring-2 focus-visible:ring-focus",
                name === color && "ring-2 ring-foreground/70"
              )}
            />
          ))}
        </div>
      )}
      {value && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-muted outline-none transition-colors hover:bg-default hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus"
        >
          <X size={12} />
          {t("notes.context.removeIcon")}
        </button>
      )}
    </div>
  );
}
