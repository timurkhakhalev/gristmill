import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { getCachedPlatform } from "../utils/platform";
import { cn } from "./lib/utils";

interface ShortcutRow {
  labelKey: string;
  defaultLabel: string;
  keys: string[];
}

interface ShortcutGroup {
  labelKey: string;
  defaultLabel: string;
  rows: ShortcutRow[];
}

const platform = getCachedPlatform();

const mod = platform === "darwin" ? "⌘" : "Ctrl";

function groups(): ShortcutGroup[] {
  return [
    {
      labelKey: "shortcutsDialog.groups.navigation",
      defaultLabel: "Navigation",
      rows: [
        {
          labelKey: "commandSearch.title",
          defaultLabel: "Search",
          keys: [mod, "K"],
        },
        {
          labelKey: "shortcutsDialog.nextNote",
          defaultLabel: "Next / previous note",
          keys: [mod, "⇧", "[ / ]"],
        },
        {
          labelKey: "shortcutsDialog.switchView",
          defaultLabel: "Switch notes / upload",
          keys: [mod, "1 / 2"],
        },
        {
          labelKey: "sidebar.settings",
          defaultLabel: "Settings",
          keys: [mod, ","],
        },
      ],
    },
    {
      labelKey: "shortcutsDialog.groups.notes",
      defaultLabel: "Notes",
      rows: [
        {
          labelKey: "notes.list.newNote",
          defaultLabel: "New note",
          keys: [mod, "N"],
        },
        {
          labelKey: "notes.context.newFolder",
          defaultLabel: "New folder",
          keys: [mod, "⇧", "N"],
        },
        {
          labelKey: "shortcutsDialog.findInNote",
          defaultLabel: "Find in note",
          keys: [mod, "F"],
        },
      ],
    },
    {
      labelKey: "shortcutsDialog.groups.help",
      defaultLabel: "Help",
      rows: [
        {
          labelKey: "shortcutsDialog.showShortcuts",
          defaultLabel: "Keyboard shortcuts",
          keys: [mod, "/"],
        },
      ],
    },
  ];
}

/** Read-only cheat sheet for the app-level shortcuts wired in ControlPanel.
 * Cmd+F is Chromium's native find-in-page, listed for discoverability only. */
export default function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("shortcutsDialog.title", "Keyboard shortcuts")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {groups().map((group) => (
            <section key={group.labelKey} className="flex flex-col gap-1.5">
              <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted">
                {t(group.labelKey, group.defaultLabel)}
              </h3>
              {group.rows.map((row) => (
                <div key={row.labelKey} className="flex items-center justify-between gap-4">
                  <span className="text-sm text-foreground">
                    {t(row.labelKey, row.defaultLabel)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1" dir="ltr">
                    {row.keys.map((key, index) => (
                      <kbd
                        key={index}
                        className={cn(
                          "rounded-md border border-border bg-default px-1.5 py-0.5 font-sans text-2xs font-medium text-muted"
                        )}
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
