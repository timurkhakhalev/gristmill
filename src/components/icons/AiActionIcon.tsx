import type { IconComponent } from "./createIcon";
import { Sparkles, WandSparkles } from "./index";

const KEY_ICON = {
  sparkles: Sparkles,
  "wand-sparkles": WandSparkles,
  wand: WandSparkles,
} satisfies Record<string, IconComponent>;

function isKnownKey(name: string): name is keyof typeof KEY_ICON {
  return Object.prototype.hasOwnProperty.call(KEY_ICON, name);
}

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
  const key = icon ?? "";
  const Resolved = isKnownKey(key) ? KEY_ICON[key] : WandSparkles;

  return <Resolved size={size} className={className} />;
}
