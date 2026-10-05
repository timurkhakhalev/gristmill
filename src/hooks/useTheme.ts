import { useEffect } from "react";
import { useSettings } from "./useSettings";
import { useSettingsStore } from "../stores/settingsStore";
import { normalizeColorScheme } from "../config/colorSchemes";

export function useTheme() {
  const { theme, setTheme } = useSettings();
  const colorScheme = useSettingsStore((s) => s.colorScheme);

  // On <html> and <body> alike: body carries .dark too, and the
  // .dark[data-color-scheme] rules in index.css must match wherever .dark does.
  useEffect(() => {
    const scheme = normalizeColorScheme(colorScheme);
    document.documentElement.dataset.colorScheme = scheme;
    document.body.dataset.colorScheme = scheme;
  }, [colorScheme]);

  useEffect(() => {
    const htmlElement = document.documentElement;

    // Determine effective theme
    const effectiveTheme: "light" | "dark" =
      theme === "auto"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;

    // Apply dark class
    if (effectiveTheme === "dark") {
      htmlElement.classList.add("dark");
      document.body.classList.add("dark");
    } else {
      htmlElement.classList.remove("dark");
      document.body.classList.remove("dark");
    }

    // Listen for system preference changes (only when auto)
    if (theme === "auto") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

      const handler = (e: MediaQueryListEvent) => {
        if (e.matches) {
          htmlElement.classList.add("dark");
          document.body.classList.add("dark");
        } else {
          htmlElement.classList.remove("dark");
          document.body.classList.remove("dark");
        }
      };

      mediaQuery.addEventListener("change", handler);

      return () => mediaQuery.removeEventListener("change", handler);
    }
  }, [theme]);

  return { theme, setTheme };
}
