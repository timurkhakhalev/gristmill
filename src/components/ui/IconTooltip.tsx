import type { ReactNode } from "react";
import { Tooltip } from "@heroui/react";

/** Short hover/focus label for an icon-only HeroUI control. */
export function IconTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip delay={400} closeDelay={0}>
      {children}
      <Tooltip.Content className="text-xs">{label}</Tooltip.Content>
    </Tooltip>
  );
}
