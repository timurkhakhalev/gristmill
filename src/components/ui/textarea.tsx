import * as React from "react";

import { cn } from "../lib/utils";
import { FIELD_CLASS } from "./surfaceStyles";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          FIELD_CLASS,
          "flex min-h-20 py-2 resize-y cursor-text",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
