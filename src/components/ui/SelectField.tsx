import React from "react";
import { Label, ListBox, Select } from "@heroui/react";
import { SettingsRowLabelContext } from "./settingsRowLabel";

export interface SelectFieldOption {
  id: string;
  label: string;
}

/** Single-value HeroUI Select for settings and compact forms. */
export function SelectField({
  value,
  options,
  onChange,
  ariaLabel,
  className = "w-44",
  isDisabled,
}: {
  value: string;
  options: SelectFieldOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  isDisabled?: boolean;
}) {
  const rowLabel = React.useContext(SettingsRowLabelContext);
  return (
    <Select
      aria-label={ariaLabel ?? rowLabel ?? undefined}
      value={value}
      onChange={(key) => key != null && onChange(String(key))}
      isDisabled={isDisabled}
      className={className}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
              <Label>{option.label}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
