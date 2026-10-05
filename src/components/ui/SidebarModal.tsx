import React from "react";
import { Modal } from "@heroui/react";
import { SettingsLayoutProvider } from "./useSettingsLayout";

export interface SidebarItem<T extends string> {
  id: T;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group?: string;
  description?: string;
  badge?: string;
  badgeVariant?: "default" | "new" | "update" | "dot";
  shortcut?: string;
}

interface SidebarModalProps<T extends string> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  sidebarItems: SidebarItem<T>[];
  activeSection: T;
  onSectionChange: (section: T) => void;
  children: React.ReactNode;
  sidebarWidth?: string;
  version?: string;
  /** Rendered above the nav (hidden in compact mode), e.g. account identity. */
  header?: React.ReactNode;
}

export default function SidebarModal<T extends string>({
  open,
  onOpenChange,
  title,
  sidebarItems,
  activeSection,
  onSectionChange,
  children,
  sidebarWidth = "w-52",
  version,
  header,
}: SidebarModalProps<T>) {
  const [isCompact, setIsCompact] = React.useState(false);
  const observerRef = React.useRef<ResizeObserver | null>(null);

  const containerRef = React.useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setIsCompact(width > 0 && width < 800);
    });

    observer.observe(el);
    observerRef.current = observer;
  }, []);

  // Group items by their group property
  const groupedItems = React.useMemo(() => {
    const groups: { label: string | null; items: SidebarItem<T>[] }[] = [];
    let currentGroup: string | null | undefined = undefined;

    for (const item of sidebarItems) {
      const group = item.group ?? null;

      if (group !== currentGroup) {
        groups.push({ label: group, items: [item] });
        currentGroup = group;
      } else {
        groups[groups.length - 1].items.push(item);
      }
    }

    return groups;
  }, [sidebarItems]);

  const renderBadge = (item: SidebarItem<T>) => {
    if (!item.badge && item.badgeVariant !== "dot") return null;

    if (item.badgeVariant === "dot") {
      return <span className="ms-auto h-1.5 w-1.5 rounded-full bg-primary shrink-0" />;
    }

    return (
      <span
        className={`ms-auto text-xs font-semibold uppercase tracking-wider px-1.5 py-px rounded-sm shrink-0 ${
          item.badgeVariant === "new"
            ? "bg-primary/10 text-primary dark:bg-primary/15"
            : item.badgeVariant === "update"
              ? "bg-warning/10 text-warning dark:bg-warning/15"
              : "bg-subtle text-muted"
        }`}
      >
        {item.badge}
      </span>
    );
  };

  const actualSidebarWidth = isCompact ? "w-12" : sidebarWidth;

  return (
    <Modal isOpen={open} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container className="p-4">
          <Modal.Dialog
            aria-label={title}
            className="h-[85vh] max-h-[85vh] w-[90vw] max-w-4xl overflow-hidden rounded-xl border border-border bg-background p-0 shadow-overlay dark:bg-surface-1"
          >
            <div className="relative h-full overflow-hidden">
              <Modal.CloseTrigger className="end-4 top-4 z-10" />

              <div ref={containerRef} className="flex h-[85vh]">
                {/* Sidebar */}
                <div
                  className={`${actualSidebarWidth} shrink-0 border-e border-border/70 dark:border-border-subtle flex flex-col bg-surface-1 dark:bg-surface-0 transition-[width] duration-200 ease-out`}
                >
                  {/* Identity / custom header */}
                  {header && !isCompact && <div className="px-4 pt-5 pb-1">{header}</div>}

                  {/* Navigation */}
                  <nav
                    className={`relative flex-1 pb-2 overflow-y-auto ${
                      isCompact ? "px-1.5 pt-4" : "px-2 pt-3"
                    }`}
                  >
                    {groupedItems.map((group, groupIndex) => (
                      <div key={groupIndex} className={groupIndex > 0 ? "mt-4" : ""}>
                        {!isCompact && group.label && (
                          <div className="px-2 pb-1">
                            <span className="text-2xs font-medium text-muted">{group.label}</span>
                          </div>
                        )}
                        <div className="space-y-px">
                          {group.items.map((item) => {
                            const Icon = item.icon;
                            const isActive = activeSection === item.id;

                            return (
                              <button
                                key={item.id}
                                data-section-id={item.id}
                                onClick={() => onSectionChange(item.id)}
                                title={isCompact ? item.label : undefined}
                                className={`group relative w-full flex items-center text-start text-xs rounded-md transition-colors duration-100 outline-none ${
                                  isCompact ? "justify-center px-0 py-2" : "gap-2 px-2 py-1.5"
                                } ${
                                  isActive
                                    ? "text-foreground bg-subtle dark:bg-surface-raised"
                                    : "text-muted hover:text-foreground hover:bg-subtle/60 dark:hover:bg-surface-2"
                                }`}
                              >
                                <Icon
                                  className={`h-4 w-4 shrink-0 transition-colors duration-100 ${
                                    isActive
                                      ? "text-primary"
                                      : "text-muted group-hover:text-foreground/80"
                                  }`}
                                />
                                {!isCompact && (
                                  <>
                                    <span
                                      className={`flex-1 truncate leading-tight ${isActive ? "font-medium" : "font-normal"}`}
                                    >
                                      {item.label}
                                    </span>
                                    {renderBadge(item)}
                                    {item.shortcut && !item.badge && (
                                      <kbd
                                        dir="ltr"
                                        className="ms-auto text-xs text-muted font-mono shrink-0"
                                      >
                                        {item.shortcut}
                                      </kbd>
                                    )}
                                  </>
                                )}
                                {isCompact && item.badgeVariant === "dot" && (
                                  <span className="absolute top-1.5 end-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </nav>

                  {/* Footer / version */}
                  {version && (
                    <div
                      className={`border-t border-border/70 dark:border-border-subtle ${
                        isCompact ? "flex justify-center py-2.5" : "px-3 py-2.5"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <div className="h-1 w-1 rounded-full bg-success/60" />
                        {!isCompact && (
                          <span dir="ltr" className="text-xs text-muted tabular-nums tracking-wide">
                            v{version}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Main Content */}
                <div className="flex-1 overflow-y-auto bg-background dark:bg-surface-1">
                  <SettingsLayoutProvider value={{ isCompact }}>
                    <div className={isCompact ? "p-4" : "p-6"}>{children}</div>
                  </SettingsLayoutProvider>
                </div>
              </div>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
