import { cloneElement, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Command,
  Database,
  ListChecks,
  Loader2,
  LogIn,
  LogOut,
  Moon,
  Play,
  RotateCcw,
  ScanLine,
  Search,
  Settings,
  Sun,
  UserRound,
  Users,
  Workflow,
  Zap,
} from "lucide-react";

import { type NavigationItem, type PageID } from "@/app/navigation";
import { applyThemeMode, getStoredThemeMode, resolvedThemeMode, storeThemeMode, type ThemeMode, watchSystemTheme } from "@/app/theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type CurrentUser, type WorkflowRun } from "@/lib/api";
import { cn } from "@/lib/utils";

type HeaderActionsProps = {
  user: CurrentUser | null;
  hasPermission: (permission: string) => boolean;
  onLogout: () => void;
  onOpenLogin: () => void;
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
  onOpenCommandPalette: () => void;
};

type SystemAction = "local_scan" | "dlsite_sync" | "recover_stale";

export function HeaderActions({ user, hasPermission, onLogout, onOpenLogin, onOpenPage, onOpenPath, onOpenCommandPalette }: HeaderActionsProps) {
  const canRunWorkflows = hasPermission("workflows:run");
  const canSyncMetadata = hasPermission("metadata:sync");
  const canManageUsers = hasPermission("users:manage");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [reviewRuns, setReviewRuns] = useState<WorkflowRun[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [runningAction, setRunningAction] = useState<SystemAction | null>(null);

  useEffect(() => {
    applyThemeMode(themeMode);
    storeThemeMode(themeMode);
    return watchSystemTheme(() => {
      if (getStoredThemeMode() === "system") applyThemeMode("system");
    });
  }, [themeMode]);

  const refreshReviewRuns = () => {
    if (!canRunWorkflows) return;
    api
      .listWorkflowRuns(1, 5, "review")
      .then((page) => {
        setReviewRuns(page.runs);
        setReviewCount(page.total);
      })
      .catch(() => {
        setReviewRuns([]);
        setReviewCount(0);
      });
  };

  useEffect(() => {
    refreshReviewRuns();
    if (!canRunWorkflows) return;
    const timer = window.setInterval(refreshReviewRuns, 30000);
    return () => window.clearInterval(timer);
  }, [canRunWorkflows]);

  const runSystemAction = async (action: SystemAction) => {
    setRunningAction(action);
    try {
      if (action === "local_scan") await api.runLocalScan();
      if (action === "dlsite_sync") await api.runDLsiteSync();
      if (action === "recover_stale") await api.recoverStaleWorkflowRuns();
      onOpenPage("activity");
      window.setTimeout(refreshReviewRuns, 800);
    } finally {
      setRunningAction(null);
      setActionsOpen(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="icon" aria-label="Open command palette" title="Command palette" onClick={onOpenCommandPalette}>
        <Search className="h-4 w-4" />
      </Button>

      {canRunWorkflows && (
        <HeaderPopover
          open={reviewOpen}
          onOpenChange={(open) => {
            setReviewOpen(open);
            if (open) refreshReviewRuns();
          }}
          trigger={
            <Button variant="outline" size="icon" aria-label="Review runs" title="Review runs" className="relative">
              <Bell className="h-4 w-4" />
              {reviewCount > 0 && <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-destructive px-1 text-[10px] font-semibold leading-5 text-destructive-foreground">{reviewCount > 99 ? "99+" : reviewCount}</span>}
            </Button>
          }
          align="right"
        >
          <div className="w-80">
            <PopoverHeader title="Review runs" subtitle={reviewCount > 0 ? `${reviewCount} runs need attention` : "No runs need review"} />
            <div className="max-h-80 overflow-auto p-2">
              {reviewRuns.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No review items right now.</div>
              ) : (
                reviewRuns.map((run) => (
                  <button
                    key={run.id}
                    className="mb-1 flex w-full items-start gap-3 rounded-md p-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setReviewOpen(false);
                      onOpenPath("/activity?view=review");
                    }}
                  >
                    <Workflow className="mt-0.5 h-4 w-4 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{run.displayName}</span>
                      <span className="block truncate text-xs text-muted-foreground">{run.workflowCode} · {run.status}</span>
                    </span>
                    <Badge variant="warning">{workflowReviewCount(run)}</Badge>
                  </button>
                ))
              )}
            </div>
            <PopoverFooter>
              <Button variant="outline" size="sm" onClick={() => { setReviewOpen(false); onOpenPath("/activity?view=review"); }}>
                <Activity className="h-4 w-4" />
                Open Activity
              </Button>
            </PopoverFooter>
          </div>
        </HeaderPopover>
      )}

      <div className="hidden sm:block">
        <HeaderPopover
          open={actionsOpen}
          onOpenChange={setActionsOpen}
          trigger={
            <Button variant="outline" size="icon" aria-label="Quick actions" title="Quick actions">
              <Zap className="h-4 w-4" />
            </Button>
          }
          align="right"
        >
          <div className="w-72">
            <PopoverHeader title="Quick actions" subtitle="Run common maintenance tasks" />
            <MenuList>
              {canRunWorkflows && <ActionItem icon={<ScanLine className="h-4 w-4" />} label="Run local scan" busy={runningAction === "local_scan"} onClick={() => void runSystemAction("local_scan")} />}
              {canSyncMetadata && <ActionItem icon={<Database className="h-4 w-4" />} label="Run DLsite sync" busy={runningAction === "dlsite_sync"} onClick={() => void runSystemAction("dlsite_sync")} />}
              {canRunWorkflows && <ActionItem icon={<RotateCcw className="h-4 w-4" />} label="Recover stale runs" busy={runningAction === "recover_stale"} onClick={() => void runSystemAction("recover_stale")} />}
              <ActionItem icon={<Settings className="h-4 w-4" />} label="Open Settings" onClick={() => { setActionsOpen(false); onOpenPage("settings"); }} />
              {canRunWorkflows && <ActionItem icon={<Workflow className="h-4 w-4" />} label="Open Workflows" onClick={() => { setActionsOpen(false); onOpenPage("workflows"); }} />}
            </MenuList>
          </div>
        </HeaderPopover>
      </div>

      <div className="hidden sm:block">
        <HeaderPopover
          open={themeOpen}
          onOpenChange={setThemeOpen}
          trigger={
            <Button variant="outline" size="icon" aria-label="Theme" title={`Theme: ${themeMode}`}>
              {resolvedThemeMode(themeMode) === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </Button>
          }
          align="right"
        >
          <div className="w-48">
            <PopoverHeader title="Theme" subtitle="Choose display mode" />
            <MenuList>
              <ThemeItem mode="light" current={themeMode} icon={<Sun className="h-4 w-4" />} onSelect={setThemeMode} />
              <ThemeItem mode="dark" current={themeMode} icon={<Moon className="h-4 w-4" />} onSelect={setThemeMode} />
              <ThemeItem mode="system" current={themeMode} icon={<Command className="h-4 w-4" />} onSelect={setThemeMode} />
            </MenuList>
          </div>
        </HeaderPopover>
      </div>

      {user ? (
        <HeaderPopover
          open={userOpen}
          onOpenChange={setUserOpen}
          trigger={
            <Button variant="outline" className="h-10 gap-2 px-2 sm:px-3" aria-label="User menu">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{userInitial(user)}</span>
              <span className="hidden min-w-0 text-left sm:block">
                <span className="block max-w-32 truncate text-xs font-medium leading-4">{user.displayName || user.username}</span>
                <span className="block max-w-32 truncate text-[10px] leading-3 text-muted-foreground">{user.role}{user.devMode ? " · dev" : ""}</span>
              </span>
              <ChevronDown className="hidden h-3.5 w-3.5 sm:block" />
            </Button>
          }
          align="right"
        >
          <div className="w-72">
            <div className="border-b p-3">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{userInitial(user)}</span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{user.displayName || user.username}</div>
                  <div className="truncate text-xs text-muted-foreground">@{user.username}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge variant="outline">{user.role}</Badge>
                {user.devMode && <Badge variant="warning">dev mode</Badge>}
              </div>
            </div>
            <MenuList>
              <ActionItem icon={<Settings className="h-4 w-4" />} label="Settings" onClick={() => { setUserOpen(false); onOpenPage("settings"); }} />
              {canManageUsers && <ActionItem icon={<Users className="h-4 w-4" />} label="Users" onClick={() => { setUserOpen(false); onOpenPage("users"); }} />}
              {user.devMode ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Dev mode session does not require sign out.</div>
              ) : (
                <ActionItem icon={<LogOut className="h-4 w-4" />} label="Sign out" onClick={() => { setUserOpen(false); onLogout(); }} />
              )}
            </MenuList>
          </div>
        </HeaderPopover>
      ) : (
        <Button variant="outline" className="h-10 gap-2 px-3" onClick={onOpenLogin}>
          <LogIn className="h-4 w-4" />
          <span className="hidden sm:inline">Sign in</span>
        </Button>
      )}
    </div>
  );
}

function HeaderPopover({
  open,
  onOpenChange,
  trigger,
  children,
  align = "left",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  children: ReactNode;
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onOpenChange(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onOpenChange]);

  return (
    <div className="relative" ref={ref}>
      {cloneElement(trigger, { onClick: () => onOpenChange(!open) })}
      {open && (
        <div className={cn("absolute top-full z-50 mt-2 overflow-hidden rounded-lg border bg-card shadow-xl", align === "right" ? "right-0" : "left-0")}>
          {children}
        </div>
      )}
    </div>
  );
}

function PopoverHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border-b p-3">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-muted-foreground">{subtitle}</div>
    </div>
  );
}

function PopoverFooter({ children }: { children: ReactNode }) {
  return <div className="flex justify-end border-t p-2">{children}</div>;
}

function MenuList({ children }: { children: ReactNode }) {
  return <div className="p-2">{children}</div>;
}

function ActionItem({ icon, label, busy, onClick }: { icon: ReactNode; label: string; busy?: boolean; onClick: () => void }) {
  return (
    <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted disabled:opacity-60" disabled={busy} onClick={onClick}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function ThemeItem({ mode, current, icon, onSelect }: { mode: ThemeMode; current: ThemeMode; icon: ReactNode; onSelect: (mode: ThemeMode) => void }) {
  return (
    <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted" onClick={() => onSelect(mode)}>
      {icon}
      <span className="min-w-0 flex-1 capitalize">{mode}</span>
      {mode === current && <CheckCircle2 className="h-4 w-4 text-primary" />}
    </button>
  );
}

function workflowReviewCount(run: WorkflowRun) {
  return run.pendingCandidates + run.skippedNodeRuns + run.skippedJobs + (run.status === "partial" || run.status === "skipped" ? 1 : 0);
}

function userInitial(user: CurrentUser) {
  return (user.displayName || user.username || "U").trim().slice(0, 1).toUpperCase();
}

export function commandActions({
  hasPermission,
  visibleNavItems,
  onOpenPage,
  onOpenPath,
}: {
  hasPermission: (permission: string) => boolean;
  visibleNavItems: readonly NavigationItem[];
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
}) {
  return [
    ...visibleNavItems.map((item) => ({
      id: `page:${item.id}`,
      label: item.label,
      description: item.path,
      icon: <item.icon className="h-4 w-4" />,
      run: () => onOpenPage(item.id),
    })),
    ...(hasPermission("workflows:run")
      ? [
          { id: "activity:running", label: "Running runs", description: "Open current workflow activity", icon: <Activity className="h-4 w-4" />, run: () => onOpenPath("/activity") },
          { id: "activity:review", label: "Review runs", description: "Open workflow runs needing review", icon: <ListChecks className="h-4 w-4" />, run: () => onOpenPath("/activity?view=review") },
          { id: "activity:failed", label: "Failed runs", description: "Open failed workflow runs", icon: <Clock3 className="h-4 w-4" />, run: () => onOpenPath("/activity?view=failed") },
        ]
      : []),
    ...(hasPermission("workflows:run")
      ? [
          { id: "action:local_scan", label: "Run local scan", description: "Queue a local library scan", icon: <ScanLine className="h-4 w-4" />, run: () => void api.runLocalScan().then(() => onOpenPath("/activity")) },
          { id: "action:recover_stale", label: "Recover stale workflow runs", description: "Mark stale claimed jobs recoverable", icon: <RotateCcw className="h-4 w-4" />, run: () => void api.recoverStaleWorkflowRuns().then(() => onOpenPath("/activity")) },
        ]
      : []),
    ...(hasPermission("metadata:sync")
      ? [{ id: "action:dlsite_sync", label: "Run DLsite sync", description: "Queue metadata synchronization", icon: <Play className="h-4 w-4" />, run: () => void api.runDLsiteSync().then(() => onOpenPath("/activity")) }]
      : []),
  ];
}
