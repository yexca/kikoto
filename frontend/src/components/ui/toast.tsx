import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { LOGIN_REQUEST_EVENT } from "@/app/events";

export type ToastKind = "success" | "info" | "warning" | "error";

type ToastInput = {
  kind?: ToastKind;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

type ToastItem = ToastInput & {
  id: number;
  kind: ToastKind;
  durationMs: number;
};

type ToastContextValue = {
  notify: (toast: ToastInput) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback((toast: ToastInput) => {
    const kind = toast.kind ?? "info";
    const item: ToastItem = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      kind,
      message: toast.message,
      actionLabel: toast.actionLabel,
      onAction: toast.onAction,
      durationMs: toastDuration(kind),
    };
    setItems((current) => [...current.slice(-4), item]);
    window.setTimeout(() => remove(item.id), item.durationMs);
  }, [remove]);

  const value = useMemo<ToastContextValue>(() => ({
    notify,
    success: (message) => notify({ kind: "success", message }),
    info: (message) => notify({ kind: "info", message }),
    warning: (message) => notify({ kind: "warning", message }),
    error: (message) => notify({ kind: "error", message }),
  }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport items={items} onClose={remove} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return value;
}

export function toastFromError(error: unknown, fallback: string): ToastInput {
  if (error instanceof ApiError && error.status === 401) {
    return {
      kind: "warning",
      message: "Please sign in to use this feature.",
      actionLabel: "Sign in",
      onAction: () => window.dispatchEvent(new Event(LOGIN_REQUEST_EVENT)),
    };
  }
	if (error instanceof ApiError && error.code === "database_busy") {
		return { kind: "warning", message: "The database is busy. Please retry in a moment." };
	}
  return { kind: "error", message: error instanceof Error ? error.message : fallback };
}

function ToastViewport({ items, onClose }: { items: ToastItem[]; onClose: (id: number) => void }) {
  const top = useToastTopOffset(items.length > 0);
  if (items.length === 0) return null;
  return (
    <div
      className="fixed inset-x-3 z-[80] flex flex-col gap-2 sm:left-auto sm:right-4 sm:w-[min(360px,calc(100vw-2rem))]"
      style={{ top }}
      aria-live="polite"
      aria-atomic="false"
    >
      {[...items].reverse().map((item) => (
        <ToastNotice key={item.id} toast={item} onClose={() => onClose(item.id)} />
      ))}
    </div>
  );
}

function ToastNotice({ toast, onClose }: { toast: ToastItem; onClose: () => void }) {
  const Icon = toast.kind === "error" ? AlertCircle : toast.kind === "success" ? CheckCircle2 : Info;
  return (
    <div className={cn("relative overflow-hidden rounded-lg border bg-card shadow-xl", toastTone(toast.kind))}>
      <div className="flex items-start gap-3 p-3 pr-10 text-sm">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1 text-card-foreground">{toast.message}</div>
        {toast.actionLabel && toast.onAction && (
          <button
            className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/15"
            onClick={() => {
              toast.onAction?.();
              onClose();
            }}
          >
            {toast.actionLabel}
          </button>
        )}
        <button className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Dismiss notification" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="h-1 bg-muted">
        <div
          className={cn("h-full origin-left animate-toast-progress", toast.kind === "error" ? "bg-destructive" : toast.kind === "warning" ? "bg-accent-foreground" : "bg-primary")}
          style={{ animationDuration: `${toast.durationMs}ms` }}
        />
      </div>
    </div>
  );
}

function useToastTopOffset(active: boolean) {
  const [top, setTop] = useState(76);

  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    let resizeObserver: ResizeObserver | null = null;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const avoid = Array.from(document.querySelectorAll<HTMLElement>("[data-toast-avoid]"));
        const bottom = avoid.reduce((current, element) => {
          const rect = element.getBoundingClientRect();
          if (rect.bottom <= 0 || rect.top >= window.innerHeight) return current;
          return Math.max(current, rect.bottom);
        }, 64);
        setTop(Math.min(Math.max(12, window.innerHeight - 96), Math.ceil(bottom + 12)));
        resizeObserver?.disconnect();
        resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
        avoid.forEach((element) => resizeObserver?.observe(element));
      });
    };
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    measure();
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active]);

  return top;
}

function toastDuration(kind: ToastKind) {
  if (kind === "success") return 5000;
  if (kind === "info") return 3000;
  if (kind === "error") return 20000;
  return 10000;
}

function toastTone(kind: ToastKind) {
  if (kind === "error") return "border-destructive/40 text-destructive";
  if (kind === "warning") return "border-accent text-accent-foreground";
  if (kind === "success") return "border-primary/35 text-primary";
  return "border-border text-foreground";
}
