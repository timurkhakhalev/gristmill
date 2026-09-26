import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import {
  COLOR_SCHEME_IDS,
  COLOR_SCHEME_SWATCHES,
  type ColorSchemeId,
} from "../../config/colorSchemes";

interface ColorSchemePickerProps {
  value: ColorSchemeId;
  onChange: (value: ColorSchemeId) => void;
  label: string;
}

/** A row of scheme swatches (accent over the scheme's background), one radio each. */
export function ColorSchemePicker({ value, onChange, label }: ColorSchemePickerProps) {
  const { t } = useTranslation();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, step: number) => {
    const next = (from + step + COLOR_SCHEME_IDS.length) % COLOR_SCHEME_IDS.length;
    onChange(COLOR_SCHEME_IDS[next]);
    buttons.current[next]?.focus();
  };

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground">
        {t(`settingsPage.general.colorScheme.names.${value}`)}
      </span>
      <div role="radiogroup" aria-label={label} className="flex items-center gap-1.5">
        {COLOR_SCHEME_IDS.map((id, index) => {
          const name = t(`settingsPage.general.colorScheme.names.${id}`);
          const selected = id === value;
          const swatch = COLOR_SCHEME_SWATCHES[id];
          return (
            <button
              key={id}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={name}
              title={name}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  move(index, 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(index, -1);
                }
              }}
              className={cn(
                "flex size-6 items-center justify-center rounded-full border border-black/10 outline-none transition-shadow dark:border-white/10",
                "focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                selected && "ring-2 ring-foreground/70 ring-offset-2 ring-offset-background"
              )}
              style={{ background: swatch.background }}
            >
              <span className="size-3 rounded-full" style={{ background: swatch.accent }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
