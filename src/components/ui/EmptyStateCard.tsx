import type { ComponentType, ReactNode } from "react";
import { cn } from "../lib/utils";

interface EmptyStateCardProps {
  icon: ComponentType<{ size?: number; className?: string }>;
  title?: string;
  description?: string;
  /** Actions or previews, stacked and centred under the copy. */
  children?: ReactNode;
  className?: string;
}

/** Card-shaped empty state: icon tile, title, one-line description, then the single next action. */
export default function EmptyStateCard({
  icon: Icon,
  title,
  description,
  children,
  className,
}: EmptyStateCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-border bg-surface px-6 py-10 text-center",
        className
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-surface-secondary text-muted-foreground">
        <Icon size={20} />
      </span>
      {title && <p className="mt-4 text-sm font-semibold text-foreground">{title}</p>}
      {description && (
        <p className="mt-1 max-w-xs text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {children && <div className="mt-5 flex flex-col items-center gap-2">{children}</div>}
    </div>
  );
}
