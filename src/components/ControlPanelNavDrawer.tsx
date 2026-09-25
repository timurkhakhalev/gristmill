import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";

export const NAV_DRAWER_MS = 300;

interface ControlPanelNavDrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/** Overlay drawer that stays mounted through the close transition. */
export default function ControlPanelNavDrawer({
  open,
  onClose,
  children,
}: ControlPanelNavDrawerProps) {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (open) {
      setMounted(true);
      const frame = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (!cancelled) setShown(true);
        });
      });
      return () => {
        cancelled = true;
        window.cancelAnimationFrame(frame);
      };
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), NAV_DRAWER_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;

  return (
    <>
      <button
        type="button"
        tabIndex={shown ? 0 : -1}
        aria-hidden={!shown}
        aria-label={t("sidebar.collapse")}
        onClick={onClose}
        className={cn(
          "absolute inset-0 z-40 bg-black/40 transition-opacity duration-300 ease-out",
          shown ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <div
        className={cn(
          "absolute inset-y-0 start-0 z-50 shadow-overlay",
          // Named properties so reduced-motion (index.css) can drop transform
          // and keep the fade. Closed offset is the start edge in both dirs.
          "transition-[transform,opacity] duration-300 ease-out",
          shown
            ? "translate-x-0 opacity-100"
            : "pointer-events-none -translate-x-full opacity-0 rtl:translate-x-full"
        )}
      >
        {children}
      </div>
    </>
  );
}
