import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/tailwindClassNames";

type DialogLayer = "overlay" | "overlay-nested" | "sheet" | "overlay-top";
type DialogSize = "sm" | "md" | "lg" | "xl" | "2xl" | "full";

const layerClassNames: Record<DialogLayer, string> = {
  overlay: "z-overlay",
  "overlay-nested": "z-overlay-nested",
  sheet: "z-sheet",
  "overlay-top": "z-overlay-top",
};

const sizeClassNames: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
  "2xl": "max-w-4xl",
  full: "max-w-6xl",
};

// Only the most recently opened dialog reacts to Escape, so a nested confirm
// does not also dismiss the dialog underneath it.
const escapeStack: symbol[] = [];

type DialogLabelContextValue = { titleId: string; descriptionId: string; setHasDescription: (value: boolean) => void };

const DialogLabelContext = React.createContext<DialogLabelContextValue | undefined>(undefined);

export interface DialogProps {
  onClose: () => void;
  children: React.ReactNode;
  layer?: DialogLayer;
  size?: DialogSize;
  /** Close when the backdrop is pressed. Disable while a destructive command is in flight. */
  dismissible?: boolean;
  closeOnEscape?: boolean;
  role?: "dialog" | "alertdialog";
  ariaLabel?: string;
  className?: string;
  overlayClassName?: string;
  /** Stable semantic marker for complex app-owned dialogs. */
  marker?: string;
}

export function Dialog({
  onClose,
  children,
  layer = "overlay",
  size = "md",
  dismissible = true,
  closeOnEscape = true,
  role = "dialog",
  ariaLabel,
  className,
  overlayClassName,
  marker,
}: DialogProps) {
  const titleId = React.useId();
  const descriptionId = `${titleId}-description`;
  const [hasDescription, setHasDescription] = React.useState(false);
  const labelContext = React.useMemo(() => ({ titleId, descriptionId, setHasDescription }), [titleId, descriptionId]);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const onCloseRef = React.useRef(onClose);
  const escapeEnabledRef = React.useRef(dismissible && closeOnEscape);
  React.useLayoutEffect(() => {
    onCloseRef.current = onClose;
    escapeEnabledRef.current = dismissible && closeOnEscape;
  });

  React.useEffect(() => {
    const token = Symbol("dialog");
    escapeStack.push(token);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (escapeStack[escapeStack.length - 1] !== token || !escapeEnabledRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      const index = escapeStack.indexOf(token);
      if (index >= 0) escapeStack.splice(index, 1);
    };
  }, []);

  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className={cn(
        "dialog-scrim fixed inset-0 grid place-items-center p-3 duration-150 animate-in fade-in-0 sm:p-4",
        layerClassNames[layer],
        overlayClassName,
      )}
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <DialogLabelContext.Provider value={labelContext}>
        <div
          ref={panelRef}
          role={role}
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : titleId}
          aria-describedby={hasDescription ? descriptionId : undefined}
          tabIndex={-1}
          data-kikoto-dialog={marker}
          className={cn(
            "theme-floating-surface flex max-h-[calc(100dvh-1.5rem)] w-full flex-col overflow-hidden rounded-[var(--radius)] border bg-popover text-popover-foreground shadow-2xl outline-none duration-200 animate-in fade-in-0 zoom-in-[0.97] slide-in-from-bottom-2 sm:max-h-[calc(100dvh-2rem)]",
            sizeClassNames[size],
            className,
          )}
        >
          {children}
        </div>
      </DialogLabelContext.Provider>
    </div>
  );
}

export function DialogHeader({
  title,
  description,
  icon,
  onClose,
  closeLabel,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const labels = React.useContext(DialogLabelContext);
  const hasDescription = Boolean(description);
  const setHasDescription = labels?.setHasDescription;
  React.useLayoutEffect(() => {
    if (!setHasDescription) return;
    setHasDescription(hasDescription);
    return () => setHasDescription(false);
  }, [hasDescription, setHasDescription]);
  return (
    <div className={cn("flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon ? (
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0">
          <h3 id={labels?.titleId} className="text-base font-semibold leading-6">
            {title}
          </h3>
          {description ? (
            <div id={labels?.descriptionId} className="mt-1 text-sm text-muted-foreground">
              {description}
            </div>
          ) : null}
          {children}
        </div>
      </div>
      {onClose ? (
        <button
          type="button"
          className="-mr-1.5 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={closeLabel}
          aria-label={closeLabel}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("app-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-muted/35 px-5 py-3", className)}
      {...props}
    />
  );
}
