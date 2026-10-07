import * as React from "react";
import { Popover as HeroPopover, Pressable } from "@heroui/react";
import { cn } from "../lib/utils";
import { OVERLAY_CLASS } from "./surfaceStyles";

/*
 * Popover primitives on HeroUI Popover (React Aria), keeping the Radix-style API
 * (asChild trigger, anchor, align/side). Keeping every overlay on React Aria lets
 * popovers, menus and modals nest without fighting over focus or outside clicks.
 */

const AnchorContext = React.createContext<React.RefObject<Element | null> | null>(null);

function isFunctionRef(
  value: React.Ref<Element> | undefined
): value is (node: Element | null) => void {
  return typeof value === "function";
}

function isObjectRef(
  value: React.Ref<Element> | undefined
): value is React.RefObject<Element | null> {
  return typeof value === "object" && value !== null;
}

function Popover({
  open,
  defaultOpen,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const anchorRef = React.useRef<Element | null>(null);

  return (
    <AnchorContext.Provider value={anchorRef}>
      <HeroPopover isOpen={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
        {children}
      </HeroPopover>
    </AnchorContext.Provider>
  );
}

/** Opens the popover on press. The child must be a single focusable element. */
function PopoverTrigger({ children }: { asChild?: boolean; children: React.ReactElement }) {
  // SAFETY: Pressable clones its single child and merges the press handlers onto
  // it; the child is a focusable DOM element (documented caller contract).
  const trigger = children as React.ReactElement<React.DOMAttributes<Element>, string>;

  return <Pressable>{trigger}</Pressable>;
}

/** Positions the popover against an element without making it the trigger. */
function PopoverAnchor({
  children,
}: {
  asChild?: boolean;
  children: React.ReactElement<{ ref?: React.Ref<Element> }>;
}) {
  const anchorRef = React.useContext(AnchorContext);

  const child = React.Children.only(children);
  const childRef = child.props.ref;

  const setRef = React.useCallback(
    (node: Element | null) => {
      if (anchorRef) anchorRef.current = node;

      if (isFunctionRef(childRef)) childRef(node);
      else if (isObjectRef(childRef)) childRef.current = node;
    },
    [anchorRef, childRef]
  );

  return React.cloneElement(child, { ref: setRef });
}

type Side = "top" | "bottom" | "left" | "right";

type Align = "start" | "center" | "end";

type PopoverPlacement = React.ComponentProps<typeof HeroPopover.Content>["placement"];

// React Aria cross-axis placements are top/bottom beside a left/right popover and
// start/end above or below one; a center align has no cross-axis qualifier.
const PLACEMENTS = {
  top: { start: "top start", center: "top", end: "top end" },
  bottom: { start: "bottom start", center: "bottom", end: "bottom end" },
  left: { start: "left top", center: "left", end: "left bottom" },
  right: { start: "right top", center: "right", end: "right bottom" },
} satisfies Record<Side, Record<Align, PopoverPlacement>>;

function PopoverContent({
  className,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  isNonModal,
  shouldCloseOnInteractOutside,
}: {
  className?: string;
  children: React.ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  /** Keep focus where it is (e.g. on an anchored input) instead of moving it into the popover. */
  isNonModal?: boolean;
  shouldCloseOnInteractOutside?: (element: Element) => boolean;
}) {
  const anchorRef = React.useContext(AnchorContext);
  const placement = PLACEMENTS[side][align];

  return (
    <HeroPopover.Content
      placement={placement}
      offset={sideOffset}
      isNonModal={isNonModal}
      shouldCloseOnInteractOutside={shouldCloseOnInteractOutside}
      triggerRef={anchorRef ?? undefined}
      // A popover opening under the frameless titlebar would otherwise be swallowed by its native drag region.
      // SAFETY: WebkitAppRegion is Electron's window-drag CSS seam; React's
      // CSSProperties type does not declare it.
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      className={cn("flex min-w-[220px] flex-col p-0", OVERLAY_CLASS)}
    >
      <HeroPopover.Dialog className={cn("min-h-0 overflow-y-auto p-2 outline-none", className)}>
        {children}
      </HeroPopover.Dialog>
    </HeroPopover.Content>
  );
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
