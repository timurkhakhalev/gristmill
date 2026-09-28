import * as React from "react";
import { Popover as HeroPopover, Pressable } from "@heroui/react";
import { cn } from "../lib/utils";
import { OVERLAY_CLASS } from "./surfaceStyles";

/*
 * Popover primitives on HeroUI Popover (React Aria), keeping the Radix-style API
 * (asChild trigger, anchor, align/side). Keeping every overlay on React Aria lets
 * popovers, menus and modals nest without fighting over focus or outside clicks.
 */

const AnchorContext = React.createContext<React.RefObject<HTMLElement | null> | null>(null);

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
  const anchorRef = React.useRef<HTMLElement | null>(null);
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
  return <Pressable>{children as React.ReactElement<React.DOMAttributes<Element>, string>}</Pressable>;
}

/** Positions the popover against an element without making it the trigger. */
function PopoverAnchor({ children }: { asChild?: boolean; children: React.ReactElement }) {
  const anchorRef = React.useContext(AnchorContext);
  const child = React.Children.only(children) as React.ReactElement<{ ref?: React.Ref<HTMLElement> }>;
  const childRef = (child.props as { ref?: React.Ref<HTMLElement> }).ref;
  const setRef = React.useCallback(
    (node: HTMLElement | null) => {
      if (anchorRef) anchorRef.current = node;
      if (typeof childRef === "function") childRef(node);
      else if (childRef && typeof childRef === "object") {
        (childRef as React.RefObject<HTMLElement | null>).current = node;
      }
    },
    [anchorRef, childRef]
  );
  return React.cloneElement(child, { ref: setRef });
}

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

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
  const placement = (align === "center" ? side : `${side} ${align}`) as React.ComponentProps<typeof HeroPopover.Content>["placement"];
  return (
    <HeroPopover.Content
      placement={placement}
      offset={sideOffset}
      isNonModal={isNonModal}
      shouldCloseOnInteractOutside={shouldCloseOnInteractOutside}
      triggerRef={anchorRef?.current ? (anchorRef as React.RefObject<HTMLElement>) : undefined}
      // A popover opening under the frameless titlebar would otherwise be swallowed by its native drag region.
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      className={cn("flex min-w-[220px] flex-col p-0", OVERLAY_CLASS)}
    >
      <HeroPopover.Dialog className={cn("min-h-0 overflow-y-auto p-2 outline-none", className)}>{children}</HeroPopover.Dialog>
    </HeroPopover.Content>
  );
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
