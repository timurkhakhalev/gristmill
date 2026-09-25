import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "./ProviderIcon";
import type { ColorScheme as BaseColorScheme } from "../../utils/modelPickerStyles";
import { cn } from "../lib/utils";

export interface ProviderTabItem {
  id: string;
  name: string;
  recommended?: boolean;
  disabled?: boolean;
  disabledLabel?: string;
}

type ColorScheme = Exclude<BaseColorScheme, "blue"> | "dynamic";

interface ProviderTabsProps {
  providers: ProviderTabItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  renderIcon?: (providerId: string) => ReactNode;
  colorScheme?: ColorScheme;
  /** Wrap pills onto multiple lines when there are many providers */
  wrap?: boolean;
}

export function ProviderTabs({
  providers,
  selectedId,
  onSelect,
  renderIcon,
  wrap = false,
}: ProviderTabsProps) {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      className={cn("gap-1.5", wrap ? "flex flex-wrap justify-start" : "inline-flex items-center")}
    >

      {providers.map((provider) => {
        const isSelected = selectedId === provider.id;
        const isDisabled = !!provider.disabled;

        return (
          <button
            key={provider.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={isDisabled}
            aria-disabled={isDisabled}
            title={isDisabled ? provider.disabledLabel : undefined}
            onClick={() => {
              if (isDisabled) return;
              onSelect(provider.id);
            }}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus",
              isDisabled
                ? "cursor-not-allowed border border-border text-muted-foreground opacity-60"
                : isSelected
                  ? "bg-accent text-accent-foreground"
                  : "border border-border text-foreground hover:bg-default"
            )}
          >
            {renderIcon ? renderIcon(provider.id) : <ProviderIcon provider={provider.id} />}
            <span>{provider.name}</span>
            {provider.recommended && (
              <span className={cn("text-[11px] font-medium", isSelected ? "opacity-80" : "text-primary")}>
                {t("common.recommended")}
              </span>
            )}
            {isDisabled && provider.disabledLabel && (
              <span className="text-[11px] text-muted-foreground">
                {provider.disabledLabel}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
