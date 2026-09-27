import { Terminal } from "../icons";
import { cn } from "../lib/utils";
import type { BbLogo } from "../../contracts/bb";

/**
 * bb serves each harness logo as SVG. Monochrome logos use currentColor, which an
 * <img> cannot inherit, so they are painted through a CSS mask in the text colour.
 */
export function HarnessIcon({ logo, className = "size-4" }: { logo: BbLogo | null | undefined; className?: string }) {
  if (!logo) return <Terminal className={cn("shrink-0", className)} aria-hidden />;
  if (logo.monochrome) {
    return (
      <span
        aria-hidden
        className={cn("inline-block shrink-0 bg-current", className)}
        style={{ maskImage: `url("${logo.dataUrl}")`, maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center" }}
      />
    );
  }
  return <img src={logo.dataUrl} alt="" aria-hidden className={cn("shrink-0 object-contain", className)} />;
}
