import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

// Legacy Button API rendered with HeroUI's button classes, so buttons built
// here and HeroUI <Button> look identical. Prefer HeroUI <Button> in new code.
const buttonVariants = cva("button [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0", {
  variants: {
    variant: {
      default: "button--primary",
      success:
        "button--primary [--button-bg:var(--success)] [--button-fg:var(--success-foreground)]",
      destructive: "button--danger",
      outline: "button--outline",
      "outline-flat": "button--outline text-muted-foreground hover:text-foreground",
      secondary: "button--tertiary text-foreground",
      ghost: "button--ghost",
      link: "h-auto! px-0! text-link hover:underline underline-offset-4",
      social: "button--outline",
    },
    size: {
      default: "button--md",
      sm: "button--sm",
      lg: "button--lg",
      icon: "button--md button--icon-only",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "default"}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
