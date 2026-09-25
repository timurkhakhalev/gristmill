import { createContext } from "react";

/** Label of the enclosing SettingsRow, used as the accessible name of its control. */
export const SettingsRowLabelContext = createContext<string | null>(null);
