import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, ChevronDown, Settings2 } from "../icons";
import { Description, Dropdown, Label, Separator } from "@heroui/react";
import { cn } from "../lib/utils";
import {
  useActions,
  initializeActions,
  getActionName,
  getActionCta,
  getActionDescription,
} from "../../stores/actionStore";
import type { ActionItem } from "../../contracts/actions";
import { FOLLOW_UP_EMAIL_KEY } from "../../helpers/builtinActions";

// Keyed fresh so the follow-up email default reaches installs that had
// "Generate Notes" remembered under the old key.
const ASK_BAR_ACTION_KEY = "askBarActionId";
const MANAGE_KEY = "__manage__";

interface ActionPickerProps {
  onRunAction: (action: ActionItem) => void;
  onManageActions: () => void;
  disabled?: boolean;
}

export default function ActionPicker({
  onRunAction,
  onManageActions,
  disabled,
}: ActionPickerProps) {
  const { t } = useTranslation();
  const actions = useActions();
  const [lastUsedId, setLastUsedId] = useState<number | null>(() => {
    const stored = localStorage.getItem(ASK_BAR_ACTION_KEY);
    return stored ? Number(stored) : null;
  });

  useEffect(() => {
    initializeActions();
  }, []);

  const activeAction =
    actions.find((a) => a.id === lastUsedId) ??
    actions.find((a) => a.translation_key === FOLLOW_UP_EMAIL_KEY) ??
    actions[0] ??
    null;

  const handleRun = (action: ActionItem) => {
    setLastUsedId(action.id);
    localStorage.setItem(ASK_BAR_ACTION_KEY, String(action.id));
    onRunAction(action);
  };

  if (!activeAction) return null;

  return (
    <div
      className={cn(
        "flex items-center shrink-0 rounded-full overflow-hidden",
        "bg-surface/80",
        "backdrop-blur-lg transform-gpu",
        "border border-border",
        "shadow-(--shadow-glass)",
        disabled && "opacity-40 pointer-events-none"
      )}
    >
      <button
        onClick={() => handleRun(activeAction)}
        disabled={disabled}
        aria-label={t("notes.actions.runAction", { name: getActionName(activeAction, t) })}
        className={cn(
          "flex items-center gap-1.5 h-7 ps-3 pe-1.5",
          "text-primary",
          "transition-colors duration-150",
          "hover:bg-accent-soft"
        )}
      >
        <Sparkles size={11} />
        <span className="text-2xs font-semibold tracking-tight">
          {getActionCta(activeAction, t)}
        </span>
      </button>

      <Dropdown>
        <Dropdown.Trigger
          isDisabled={disabled}
          aria-label={t("notes.actions.selectAction")}
          className={cn(
            "flex h-7 w-6 items-center justify-center pe-0.5 outline-none",
            "border-s border-border text-primary/60",
            "transition-colors duration-150",
            "hover:bg-accent-soft hover:text-primary",
            "data-[focus-visible]:ring-2 data-[focus-visible]:ring-inset data-[focus-visible]:ring-focus"
          )}
        >
          <ChevronDown size={12} />
        </Dropdown.Trigger>
        <Dropdown.Popover placement="top end" offset={8} className="min-w-56">
          <Dropdown.Menu
            aria-label={t("notes.actions.selectAction")}
            onAction={(key) => {
              if (key === MANAGE_KEY) return onManageActions();
              const action = actions.find((item) => String(item.id) === key);
              if (action) handleRun(action);
            }}
          >
            {actions.map((action) => (
              <Dropdown.Item key={action.id} id={String(action.id)} textValue={getActionName(action, t)}>
                <Sparkles size={14} className={cn("shrink-0", action.id === activeAction.id ? "text-primary" : "text-muted")} />
                <div className="min-w-0 flex-1">
                  <Label className="block truncate">{getActionName(action, t)}</Label>
                  {action.description && (
                    <Description className="block truncate">{getActionDescription(action, t)}</Description>
                  )}
                </div>
              </Dropdown.Item>
            ))}
            <Separator className="my-1" />
            <Dropdown.Item id={MANAGE_KEY} textValue={t("notes.actions.manage")}>
              <Settings2 size={14} className="shrink-0 text-muted" />
              <Label>{t("notes.actions.manage")}</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}
