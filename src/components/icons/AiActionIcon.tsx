import type { IconComponent } from "./createIcon";
import { Sparkles, WandSparkles } from "./index";

const KEY_ICON: Record<string, IconComponent> = {
  sparkles: Sparkles,
  "wand-sparkles": WandSparkles,
  wand: WandSparkles,
};

/**
 * Single source of truth for "this row generates AI output" affordances.
 * The built-in actions (Generate Notes, Detailed Notes, Follow-up email,
 * the meeting Generate AI Summary flow) all use the wand-sparkles mark;
 * anything else falls back to sparkles so AI-adjacent affordances stay
 * visually consistent without us having to remember to update each caller.
 */
export function AiActionIcon({
  icon,
  size = 16,
  className,
}: {
  icon?: string | null;
  size?: number | string;
  className?: string;
}) {
  const Resolved = KEY_ICON[icon ?? ""] ?? WandSparkles;
  return <Resolved size={size} className={className} />;
}
