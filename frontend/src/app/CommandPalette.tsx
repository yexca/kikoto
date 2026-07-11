import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, FileAudio, Search, X } from "lucide-react";

import { commandActions } from "@/app/HeaderActions";
import { type NavigationItem, type PageID } from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const WORK_CODE_PATTERN = /^(RJ|BJ|VJ|CC)\d{4,8}$/i;

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasPermission: (permission: string) => boolean;
  visibleNavItems: readonly NavigationItem[];
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
};

export function CommandPalette({ open, onOpenChange, hasPermission, visibleNavItems, onOpenPage, onOpenPath }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baseActions = useMemo(() => commandActions({ hasPermission, visibleNavItems, onOpenPage, onOpenPath }), [hasPermission, visibleNavItems, onOpenPage, onOpenPath]);
  const cleanQuery = query.trim();
  const codeMatch = WORK_CODE_PATTERN.test(cleanQuery);
  const actions = useMemo(() => {
    const queryLower = cleanQuery.toLowerCase();
    const filtered = queryLower
      ? baseActions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(queryLower))
      : baseActions;
    if (!codeMatch) return filtered;
    const code = cleanQuery.toUpperCase();
    return [
      {
        id: `code:${code}`,
        label: `Open ${code}`,
        description: "Open work detail by code",
        icon: <FileAudio className="h-4 w-4" />,
        run: () => onOpenPath(`/${encodeURIComponent(code)}`),
      },
      ...filtered,
    ];
  }, [baseActions, cleanQuery, codeMatch, onOpenPath]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  const runAction = (index: number) => {
    const action = actions[index];
    if (!action) return;
    onOpenChange(false);
    action.run();
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/55 p-4 backdrop-blur-sm" onMouseDown={() => onOpenChange(false)}>
      <div className="mx-auto mt-[10vh] flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-card shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex min-h-14 items-center gap-3 border-b px-4">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, actions.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                runAction(activeIndex);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder="Search commands or type a work code"
          />
          <Button variant="ghost" size="icon" aria-label="Close command palette" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="app-scroll min-h-0 flex-1 overflow-auto p-2">
          {actions.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No commands match.</div>
          ) : (
            actions.map((action, index) => (
              <button
                key={action.id}
                className={cn("flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm", index === activeIndex ? "bg-muted text-foreground" : "hover:bg-muted")}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runAction(index)}
              >
                <span className="text-muted-foreground">{action.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{action.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{action.description}</span>
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
