import React from "react";
import { Switch } from "@heroui/react";
import { SettingsRowLabelContext } from "./settingsRowLabel";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name; defaults to the enclosing SettingsRow label. */
  ariaLabel?: string;
}

export const Toggle = ({ checked, onChange, disabled = false, ariaLabel }: ToggleProps) => {
  const rowLabel = React.useContext(SettingsRowLabelContext);
  return (
    <Switch isSelected={checked} onChange={onChange} isDisabled={disabled}>
      <Switch.Content aria-label={ariaLabel ?? rowLabel ?? undefined}>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
};
