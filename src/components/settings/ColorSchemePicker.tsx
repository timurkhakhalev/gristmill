import { useTranslation } from "react-i18next";
import { SelectField } from "../ui/SelectField";
import {
  COLOR_SCHEME_IDS,
  COLOR_SCHEME_SWATCHES,
  normalizeColorScheme,
  type ColorSchemeId,
} from "../../config/colorSchemes";

interface ColorSchemePickerProps {
  value: ColorSchemeId;
  onChange: (value: ColorSchemeId) => void;
  label: string;
}

/** Scheme dropdown; each option shows its swatch (accent over the scheme's background). */
export function ColorSchemePicker({ value, onChange, label }: ColorSchemePickerProps) {
  const { t } = useTranslation();
  return (
    <SelectField
      value={value}
      onChange={(next) => onChange(normalizeColorScheme(next))}
      ariaLabel={label}
      className="w-44"
      options={COLOR_SCHEME_IDS.map((id) => ({
        id,
        label: t(`settingsPage.general.colorScheme.names.${id}`),
        icon: (
          <span
            aria-hidden
            className="flex size-4 shrink-0 items-center justify-center rounded border border-black/10 dark:border-white/10"
            style={{ background: COLOR_SCHEME_SWATCHES[id].background }}
          >
            <span className="size-2 rounded-full" style={{ background: COLOR_SCHEME_SWATCHES[id].accent }} />
          </span>
        ),
      }))}
    />
  );
}
