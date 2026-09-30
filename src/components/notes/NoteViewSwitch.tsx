import type { ComponentType } from "react";
import { Button, Dropdown, Label } from "@heroui/react";
import { ChevronDown } from "../icons";
import { cn } from "../lib/utils";

export interface NoteViewOption<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export interface NoteViewVersionMenu {
  label: string;
  selectedId?: string;
  items: Array<{ id: string; label: string; detail?: string }>;
  onSelect: (id: string) => void;
}

const SEGMENT =
  "inline-flex h-7 min-h-7 items-center gap-1.5 rounded-full text-ui font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus";

/**
 * Compact view switch: the active view shows icon + label (and a version menu
 * when it has one); the others collapse to icons.
 */
export default function NoteViewSwitch<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  versionMenu,
}: {
  value: T;
  options: NoteViewOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Opened from the active segment; omitted or empty means no chevron. */
  versionMenu?: NoteViewVersionMenu;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-default p-0.5">
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.id === value;
        if (!versionMenu?.items.length || !active) {
          // One stable element per option, so switching animates the label's
          // width in place instead of remounting and flashing the icon.
          return (
            <button
              key={option.id}
              type="button"
              aria-label={option.label}
              aria-pressed={active}
              title={option.label}
              onClick={() => onChange(option.id)}
              className={cn(
                SEGMENT,
                "overflow-hidden gap-0 transition-[padding,background-color,color,box-shadow] duration-200",
                active
                  ? "bg-segment px-2.5 text-segment-foreground shadow-sm"
                  : "px-[8.5px] text-muted hover:text-foreground"
              )}
            >
              <Icon size={15} className={cn("shrink-0", active && "text-primary")} />
              <span
                aria-hidden={!active}
                className={cn(
                  "grid transition-[grid-template-columns,opacity] duration-200",
                  active ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0"
                )}
              >
                <span className="overflow-hidden whitespace-nowrap ps-1.5">{option.label}</span>
              </span>
            </button>
          );
        }
        const content = (
          <>
            <Icon size={15} className="shrink-0 text-primary" />
            <span>{option.label}</span>
          </>
        );
        const activeClass = cn(SEGMENT, "overflow-hidden bg-segment px-2.5 text-segment-foreground shadow-sm");
        return (
          <Dropdown key={option.id}>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${option.label} — ${versionMenu.label}`}
              className={cn(activeClass, "pe-2 hover:bg-segment")}
            >
              {content}
              <ChevronDown size={13} className="text-muted" />
            </Button>
            <Dropdown.Popover placement="bottom start">
              <Dropdown.Menu
                aria-label={versionMenu.label}
                selectionMode="single"
                selectedKeys={versionMenu.selectedId ? [versionMenu.selectedId] : []}
                onAction={(key) => versionMenu.onSelect(String(key))}
              >
                {versionMenu.items.map((item) => (
                  <Dropdown.Item key={item.id} id={item.id} textValue={item.label}>
                    <Label>{item.label}</Label>
                    {item.detail && <span className="text-xs text-muted">{item.detail}</span>}
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        );
      })}
    </div>
  );
}
