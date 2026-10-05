import React from "react";
import { Label, ListBox, Select } from "@heroui/react";
import { cn } from "../lib/utils";
import { SettingsRowLabelContext } from "./settingsRowLabel";

export interface SelectFieldOption {
  id: string;
  label: string;
  /** Leading visual, shown in the list and in the trigger. */
  icon?: React.ReactNode;
  /** Visually separates this option from the ones above it. */
  separated?: boolean;
  disabled?: boolean;
  /** Short trailing note, e.g. why the option is disabled. */
  hint?: string;
}

/** Single-value HeroUI Select for settings and compact forms. */
export function SelectField({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  className = "w-44",
  isDisabled,
  size = "md",
  dir,
}: {
  /** Empty string shows the placeholder. */
  value: string;
  options: SelectFieldOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  isDisabled?: boolean;
  size?: "sm" | "md";
  /** Direction of the trigger value, e.g. "ltr" for technical values in an RTL UI. */
  dir?: "ltr" | "rtl" | "auto";
}) {
  const rowLabel = React.useContext(SettingsRowLabelContext);

  return (
    <Select
      aria-label={ariaLabel ?? rowLabel ?? undefined}
      value={value || null}
      onChange={(key) => key != null && onChange(String(key))}
      isDisabled={isDisabled}
      disabledKeys={options.filter((option) => option.disabled).map((option) => option.id)}
      placeholder={placeholder}
      className={className}
    >
      <Select.Trigger dir={dir} className={cn(size === "sm" && "h-8 min-h-8 text-xs")}>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item
              key={option.id}
              id={option.id}
              textValue={option.label}
              className={cn(option.separated && "mt-1 border-t border-border pt-2")}
            >
              {option.icon ? (
                <span className="flex min-w-0 items-center gap-2">
                  {option.icon}
                  <Label className="truncate">{option.label}</Label>
                </span>
              ) : (
                <Label>{option.label}</Label>
              )}
              {option.hint && (
                <span className="ms-auto text-3xs font-medium uppercase tracking-wider text-muted">
                  {option.hint}
                </span>
              )}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
