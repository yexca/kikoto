import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/tailwindClassNames";

import { lockPageScroll } from "./pageScrollLock";

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

// Only the most recently opened dialog reacts to Escape and traps Tab, so a
// nested confirm neither dismisses nor steals focus from the dialog under it.
const dialogStack: symbol[] = [];

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "iframe",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");
const floatingLayerSelector = "[data-android-back-close], [role='dialog'], [role='alertdialog']";

function isTabbable(element: HTMLElement) {
  if (element.tabIndex < 0 || element.matches(":disabled")) return false;
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  // Collapsed <details> content and display:none subtrees have no layout box.
  if (element.getClientRects().length === 0) return false;
  return window.getComputedStyle(element).visibility !== "hidden";
}

function tabbableElements(panel: HTMLElement) {
  const candidates = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(isTabbable);
  // A named radio group is one tab stop: its checked radio, or the first one.
  const radioStops = new Map<string, HTMLInputElement>();
  for (const element of candidates) {
    if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) continue;
    const stop = radioStops.get(element.name);
    if (!stop || (!stop.checked && element.checked)) radioStops.set(element.name, element);
  }
  return candidates.filter(
    (element) =>
      !(element instanceof HTMLInputElement) ||
      element.type !== "radio" ||
      !element.name ||
      radioStops.get(element.name) === element,
  );
}

/** Keeps sequential focus inside the panel; returns the element to focus, or null to let the browser move. */
function trappedTabTarget(panel: HTMLElement, backwards: boolean): HTMLElement | null {
  const tabbables = tabbableElements(panel);
  if (tabbables.length === 0) return panel;
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === panel || !panel.contains(active)) {
    // A portaled popover or sheet opened above this dialog manages its own focus;
    // a dialog that contains this one (a nested confirm's parent) does not.
    const layer = active instanceof HTMLElement && active !== panel ? active.closest(floatingLayerSelector) : null;
    if (layer && !layer.contains(panel)) return null;
    return backwards ? last : first;
  }
  if (backwards) {
    return active === first || active.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING ? last : null;
  }
  return active === last || active.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING ? first : null;
}

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
    dialogStack.push(token);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || dialogStack[dialogStack.length - 1] !== token) return;
      if (event.key === "Tab") {
        const panel = panelRef.current;
        const target = panel ? trappedTabTarget(panel, event.shiftKey) : null;
        if (!target) return;
        event.preventDefault();
        target.focus();
        return;
      }
      if (event.key !== "Escape" || !escapeEnabledRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      const index = dialogStack.indexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
    };
  }, []);

  React.useEffect(() => lockPageScroll(document.documentElement, window.innerWidth), []);

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
  return (
    <div
      className={cn("app-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4", className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-muted/35 px-5 py-3", className)}
      {...props}
    />
  );
}
