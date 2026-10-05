import * as React from "react";
import { Button, Modal } from "@heroui/react";
import { cn } from "../lib/utils";

/*
 * Dialog primitives on HeroUI Modal (React Aria), keeping the shadcn-style API
 * the app already uses. React Aria owns focus and outside-click handling, so
 * HeroUI selects, menus and popovers opened inside these dialogs nest correctly.
 */

interface DialogState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogState>({ open: false, onOpenChange: () => {} });

function Dialog({
  open = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const value = React.useMemo(
    () => ({ open, onOpenChange: onOpenChange ?? (() => {}) }),
    [open, onOpenChange]
  );

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

type DialogSize = "xs" | "sm" | "md" | "lg";

interface DialogContentProps {
  className?: string;
  children?: React.ReactNode;
  "aria-label"?: string;
  "aria-describedby"?: string;
  size?: DialogSize;
  /** Hide the corner close button (the dialog still closes on Escape). */
  hideClose?: boolean;
  /** Block closing on backdrop click, e.g. while a form is dirty. */
  isDismissable?: boolean;
}

function DialogContent({
  className,
  children,
  size = "md",
  hideClose = false,
  isDismissable = true,
  ...props
}: DialogContentProps) {
  const { open, onOpenChange } = React.useContext(DialogContext);

  return (
    <Modal isOpen={open} onOpenChange={onOpenChange}>
      <Modal.Backdrop isDismissable={isDismissable}>
        <Modal.Container size={size}>
          <Modal.Dialog className={cn("flex flex-col gap-4", className)} {...props}>
            {!hideClose && <Modal.CloseTrigger />}
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1.5 pe-8 text-start", className)} {...props} />
);

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-wrap justify-end gap-2", className)} {...props} />
);

const DialogTitle = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => (
  <Modal.Heading className={cn("text-base font-semibold leading-snug text-foreground", className)}>
    {children}
  </Modal.Heading>
);

const DialogDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-sm text-muted", className)} {...props} />
);

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  variant?: "default" | "destructive";
  /** Extra content between the header and the footer (e.g. a type-to-confirm input). */
  children?: React.ReactNode;
  confirmDisabled?: boolean;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  variant = "default",
  children,
  confirmDisabled = false,
}) => {
  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  // Enter confirms by default, except: destructive dialogs keep Cancel focused
  // (Enter must never destroy by default), and dialogs with children leave
  // focus to their own content (a type-to-confirm input owns Enter).
  const focusConfirm = children == null && variant !== "destructive";
  const focusCancel = children == null && variant === "destructive";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="tertiary" autoFocus={focusCancel} onPress={handleCancel}>
            {cancelText}
          </Button>
          <Button
            variant={variant === "destructive" ? "danger" : "primary"}
            autoFocus={focusConfirm}
            isDisabled={confirmDisabled}
            onPress={handleConfirm}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  okText?: string;
  onOk: () => void;
}

const AlertDialog: React.FC<AlertDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  okText = "OK",
  onOk,
}) => {
  const handleOk = () => {
    onOk();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button autoFocus onPress={handleOk}>
            {okText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  ConfirmDialog,
  AlertDialog,
};
