import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the custom type scale in index.css (@theme --text-*),
// otherwise text-ui/text-2xs read as text colours and get dropped in merges.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["3xs", "2xs", "ui"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
