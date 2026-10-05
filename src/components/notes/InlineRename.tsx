import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * Inline name editor for tree rows. Focus is taken after a short delay, because the
 * menu that opened it returns focus to its trigger as it closes, and a blur before
 * the editor was ever focused must not commit the rename.
 */
export function InlineRename({
  initialValue,
  onCommit,
  onCancel,
  className,
}: {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const armed = useRef(false);
  const done = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
      armed.current = true;
    }, 80);

    return () => clearTimeout(timer);
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;

    if (commit) onCommit(value);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      dir="auto"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();

        if (e.key === "Enter") finish(true);

        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => armed.current && finish(true)}
      className={cn("h-6 min-w-0 flex-1 rounded bg-default px-2 text-xs", className)}
    />
  );
}
