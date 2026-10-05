import { cn } from "../lib/utils";

/** Placeholder block shaped like content that is still loading. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-foreground/6", className)} />
  );
}

/** Entry for content that replaces a skeleton: a short fade with a slight rise. */
export const CONTENT_ENTER_CLASS =
  "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-out";
