import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

import { cn } from "@/lib/utils";

export type ToastKind = "success" | "info" | "warning" | "error";

type ToastInput = {
  kind?: ToastKind;
  message: string;
};

type ToastItem = Required<ToastInput> & {
  id: number;
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
  return { kind: "error", message: error instanceof Error ? error.message : fallback };
}

function ToastViewport({ items, onClose }: { items: ToastItem[]; onClose: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[80] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2">
      {items.map((item) => (
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

function toastDuration(kind: ToastKind) {
  if (kind === "success") return 5000;
  if (kind === "error") return 20000;
  return 10000;
}

function toastTone(kind: ToastKind) {
  if (kind === "error") return "border-destructive/40 text-destructive";
  if (kind === "warning") return "border-accent text-accent-foreground";
  if (kind === "success") return "border-primary/35 text-primary";
  return "border-border text-foreground";
}
