import { cloneElement, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Clock3,
  Command,
  Database,
  Download,
  GitBranchPlus,
  ListChecks,
  Loader2,
  LogIn,
  LogOut,
  MoreHorizontal,
  Play,
  RotateCcw,
  ScanLine,
  Search,
  Server,
  Settings,
  UserRound,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";

import { type NavigationItem, type PageID } from "@/app/navigation";
import { AppearanceControls } from "@/app/AppearanceControls";
import {
  applyThemeMode,
  applyThemePalette,
  applyThemePreset,
  getStoredThemeMode,
  getStoredThemePalette,
  getStoredThemePreset,
  storeThemeMode,
  storeThemePalette,
  storeThemePreset,
  THEME_CHANGE_EVENT,
  THEME_PALETTE_CHANGE_EVENT,
  THEME_PRESET_CHANGE_EVENT,
  type ThemeMode,
  type ThemePalette,
  type ThemePreset,
  watchSystemTheme,
} from "@/app/theme";
import { ThemeTrigger } from "@/app/ThemeTrigger";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type CurrentUser, type WorkflowNotification, type WorkflowRun } from "@/lib/api";
import { clearStoredServerURL, getStoredServerURL, isNativeApp } from "@/lib/serverConfig";
import { versionLabel } from "@/lib/appInfo";
import { buildMobileDiagnosticsText } from "@/lib/mobileDiagnostics";
import { useMobileRuntime } from "@/app/MobileRuntime";
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

export function HeaderActions({
  user,
  hasPermission,
  onLogout,
  onOpenLogin,
  onOpenPage,
  onOpenPath,
  onOpenCommandPalette,
}: HeaderActionsProps) {
  const canRunWorkflows = hasPermission("workflows:run");
  const canSyncMetadata = hasPermission("metadata:sync");
  const canManageUsers = hasPermission("users:manage");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [themePreset, setThemePreset] = useState<ThemePreset>(() => getStoredThemePreset());
  const [themePalette, setThemePalette] = useState<ThemePalette>(() => getStoredThemePalette());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("");
  const [diagnosticsText, setDiagnosticsText] = useState("");
  const [themeOpen, setThemeOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [reviewRuns, setReviewRuns] = useState<WorkflowRun[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [notifications, setNotifications] = useState<WorkflowNotification[]>([]);
  const [notificationCount, setNotificationCount] = useState(0);
  const [runningAction, setRunningAction] = useState<SystemAction | null>(null);
  const mobileRuntime = useMobileRuntime();

  useEffect(() => {
    applyThemeMode(themeMode);
    storeThemeMode(themeMode);
    return watchSystemTheme(() => {
      if (getStoredThemeMode() === "system") applyThemeMode("system");
    });
  }, [themeMode]);

  useEffect(() => {
    applyThemePreset(themePreset);
    storeThemePreset(themePreset);
  }, [themePreset]);

  useEffect(() => {
    applyThemePalette(themePalette);
    storeThemePalette(themePalette);
  }, [themePalette]);

  useEffect(() => {
    const syncTheme = (event: Event) => setThemeMode((event as CustomEvent<ThemeMode>).detail ?? getStoredThemeMode());
    window.addEventListener(THEME_CHANGE_EVENT, syncTheme);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, syncTheme);
  }, []);

  useEffect(() => {
    const syncPreset = (event: Event) =>
      setThemePreset((event as CustomEvent<ThemePreset>).detail ?? getStoredThemePreset());
    window.addEventListener(THEME_PRESET_CHANGE_EVENT, syncPreset);
    return () => window.removeEventListener(THEME_PRESET_CHANGE_EVENT, syncPreset);
  }, []);

  useEffect(() => {
    const syncPalette = (event: Event) =>
      setThemePalette((event as CustomEvent<ThemePalette>).detail ?? getStoredThemePalette());
    window.addEventListener(THEME_PALETTE_CHANGE_EVENT, syncPalette);
    return () => window.removeEventListener(THEME_PALETTE_CHANGE_EVENT, syncPalette);
  }, []);

  const refreshNotificationCenter = () => {
    if (user) {
      api
        .listNotifications(20)
        .then((page) => {
          setNotifications(page.notifications);
          setNotificationCount(page.total);
        })
        .catch(() => {
          setNotifications([]);
          setNotificationCount(0);
        });
    } else {
      setNotifications([]);
      setNotificationCount(0);
    }
    if (canRunWorkflows) {
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
    } else {
      setReviewRuns([]);
      setReviewCount(0);
    }
  };

  useEffect(() => {
    refreshNotificationCenter();
    if (!user && !canRunWorkflows) return;
    const timer = window.setInterval(refreshNotificationCenter, 30000);
    return () => window.clearInterval(timer);
  }, [canRunWorkflows, user?.id]);

  const totalNotificationCount = notificationCount + reviewCount;

  const dismissFetchNotification = async (id: number) => {
    const previous = notifications;
    const previousCount = notificationCount;
    setNotifications((items) => items.filter((item) => item.id !== id));
    setNotificationCount((count) => Math.max(0, count - 1));
    try {
      await api.dismissNotification(id);
    } catch {
      setNotifications(previous);
      setNotificationCount(previousCount);
    }
  };

  const runSystemAction = async (action: SystemAction) => {
    setRunningAction(action);
    try {
      if (action === "local_scan") await api.runLocalScan({ followUpRun: false });
      if (action === "dlsite_sync") await api.runDLsiteSync();
      if (action === "recover_stale") await api.recoverStaleWorkflowRuns();
      onOpenPage("activity");
      window.setTimeout(refreshNotificationCenter, 800);
    } finally {
      setRunningAction(null);
      setActionsOpen(false);
    }
  };

  const checkConnection = async () => {
    setConnectionStatus("Checking...");
    const health = await mobileRuntime.reconnect();
    setConnectionStatus(
      health ? `Connected · ${health.version}` : mobileRuntime.connection.message || "Connection check failed.",
    );
  };

  const showDiagnostics = async () => {
    const text = buildMobileDiagnosticsText({
      serverVersion: mobileRuntime.connection.serverVersion,
      connection: mobileRuntime.connection.message || mobileRuntime.connection.kind,
      user: user ? user.username : undefined,
    });
    setDiagnosticsText(text);
    await navigator.clipboard?.writeText(text).catch(() => {});
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button
        variant="outline"
        size="icon"
        aria-label="Open command palette"
        title="Command palette"
        onClick={onOpenCommandPalette}
      >
        <Search className="h-4 w-4" />
      </Button>

      <div className="sm:hidden">
        <HeaderPopover
          open={mobileMenuOpen}
          onOpenChange={setMobileMenuOpen}
          trigger={
            <Button variant="outline" size="icon" aria-label="Open menu" title="Menu" className="relative">
              <MoreHorizontal className="h-4 w-4" />
              {totalNotificationCount > 0 && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive" />
              )}
            </Button>
          }
          align="right"
          mobileSheet
        >
          <div className="app-scroll max-h-[calc(var(--visual-viewport-height)-4rem)] w-full overflow-y-auto">
            <PopoverHeader title="Menu" subtitle={user ? user.displayName || user.username : "Kikoto"} />
            <MenuList>
              {canRunWorkflows && (
                <>
                  <ActionItem
                    icon={<Activity className="h-4 w-4" />}
                    label="Activity"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      onOpenPath("/activity");
                    }}
                  />
                  <ActionItem
                    icon={<ListChecks className="h-4 w-4" />}
                    label={reviewCount > 0 ? `Review (${reviewCount})` : "Review"}
                    onClick={() => {
                      setMobileMenuOpen(false);
                      onOpenPath("/activity?view=review");
                    }}
                  />
                </>
              )}
              <ActionItem
                icon={<Settings className="h-4 w-4" />}
                label="Settings"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onOpenPage("settings");
                }}
              />
              {canManageUsers && (
                <ActionItem
                  icon={<Users className="h-4 w-4" />}
                  label="Users"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onOpenPath("/maintenance?tab=users");
                  }}
                />
              )}
            </MenuList>
            <div className="border-t">
              <div className="px-4 pt-3 text-xs font-semibold text-foreground">Appearance</div>
              <AppearanceControls
                mode={themeMode}
                preset={themePreset}
                palette={themePalette}
                onModeChange={(mode) => {
                  setThemeMode(mode);
                  setMobileMenuOpen(false);
                }}
                onPresetChange={setThemePreset}
                onPaletteChange={setThemePalette}
              />
            </div>
            {isNativeApp() && (
              <div className="border-t p-2">
                <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">Server</div>
                <ActionItem
                  icon={<Server className="h-4 w-4" />}
                  label="Reconnect"
                  onClick={() => void checkConnection()}
                />
                <ActionItem
                  icon={<Clipboard className="h-4 w-4" />}
                  label="Copy diagnostics"
                  onClick={() => void showDiagnostics()}
                />
                <ActionItem
                  icon={<RotateCcw className="h-4 w-4" />}
                  label="Clear server"
                  onClick={() => {
                    clearStoredServerURL();
                    window.location.reload();
                  }}
                />
              </div>
            )}
            <div className="border-t p-2">
              {user ? (
                !user.devMode &&
                !user.demoMode && (
                  <ActionItem
                    icon={<LogOut className="h-4 w-4" />}
                    label="Sign out"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      onLogout();
                    }}
                  />
                )
              ) : (
                <ActionItem
                  icon={<LogIn className="h-4 w-4" />}
                  label="Sign in"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onOpenLogin();
                  }}
                />
              )}
            </div>
          </div>
        </HeaderPopover>
      </div>

      {isNativeApp() && (
        <div className="hidden sm:block">
          <HeaderPopover
            open={connectionOpen}
            onOpenChange={(open) => {
              setConnectionOpen(open);
              if (open) {
                setConnectionStatus("");
                setDiagnosticsText("");
              }
            }}
            trigger={
              <Button variant="outline" size="icon" aria-label="Server connection" title="Server connection">
                <Server className="h-4 w-4" />
              </Button>
            }
            align="right"
          >
            <div className="w-80">
              <PopoverHeader title="Connection" subtitle="Android client server" />
              <div className="space-y-3 border-b p-3 text-sm">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Server</div>
                  <div className="mt-1 break-all font-medium">{getStoredServerURL() || "Not configured"}</div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md border bg-muted px-2 py-1.5">
                    <div className="text-muted-foreground">Client</div>
                    <div className="truncate font-medium">{versionLabel()}</div>
                  </div>
                  <div className="rounded-md border bg-muted px-2 py-1.5">
                    <div className="text-muted-foreground">Server</div>
                    <div className="truncate font-medium">{mobileRuntime.connection.serverVersion || "unknown"}</div>
                  </div>
                </div>
                {mobileRuntime.connection.message && (
                  <div className="rounded-md border bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                    {mobileRuntime.connection.message}
                  </div>
                )}
                {connectionStatus && (
                  <div className="rounded-md border bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                    {connectionStatus}
                  </div>
                )}
              </div>
              <MenuList>
                <ActionItem
                  icon={<Server className="h-4 w-4" />}
                  label="Reconnect"
                  onClick={() => void checkConnection()}
                />
                {user && (
                  <ActionItem
                    icon={<LogOut className="h-4 w-4" />}
                    label="Sign out"
                    onClick={() => {
                      setConnectionOpen(false);
                      onLogout();
                    }}
                  />
                )}
                <ActionItem
                  icon={<RotateCcw className="h-4 w-4" />}
                  label="Clear server"
                  onClick={() => {
                    clearStoredServerURL();
                    window.location.reload();
                  }}
                />
                <ActionItem
                  icon={<Clipboard className="h-4 w-4" />}
                  label="Copy diagnostics"
                  onClick={() => void showDiagnostics()}
                />
              </MenuList>
              {diagnosticsText && (
                <div className="border-t p-2">
                  <textarea
                    className="h-32 w-full resize-none rounded-md border bg-background p-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    readOnly
                    value={diagnosticsText}
                  />
                </div>
              )}
            </div>
          </HeaderPopover>
        </div>
      )}

      {user && (
        <div>
          <HeaderPopover
            open={reviewOpen}
            onOpenChange={(open) => {
              setReviewOpen(open);
              if (open) refreshNotificationCenter();
            }}
            trigger={
              <Button
                variant="outline"
                size="icon"
                aria-label="Notifications"
                title="Notifications"
                className="relative"
              >
                <Bell className="h-4 w-4" />
                {totalNotificationCount > 0 && (
                  <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-destructive px-1 text-[10px] font-semibold leading-5 text-destructive-foreground">
                    {totalNotificationCount > 99 ? "99+" : totalNotificationCount}
                  </span>
                )}
              </Button>
            }
            align="right"
          >
            <div className="w-[min(20rem,calc(100vw-1rem))]">
              <PopoverHeader
                title="Notifications"
                subtitle={totalNotificationCount > 0 ? `${totalNotificationCount} items` : "Nothing new"}
              />
              <div className="app-scroll max-h-80 overflow-auto p-2">
                {notifications.length === 0 && reviewRuns.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    No notifications right now.
                  </div>
                ) : (
                  <>
                    {notifications.map((notification) => (
                      <div
                        key={`notification-${notification.id}`}
                        className="mb-1 flex items-start rounded-md hover:bg-muted"
                      >
                        <button
                          className="flex min-w-0 flex-1 items-start gap-3 p-2 text-left text-sm"
                          onClick={() => {
                            setReviewOpen(false);
                            if (notification.type === "remote_track" && notification.status === "failed") {
                              if (canRunWorkflows) onOpenPath(`/activity?run=${notification.workflowRunId}`);
                              return;
                            }
                            const trackedSource = notification.fileSourceId
                              ? `&trackedSource=${notification.fileSourceId}`
                              : "";
                            onOpenPath(
                              notification.type === "remote_track"
                                ? `/${encodeURIComponent(notification.workCode)}?view=tracked${trackedSource}`
                                : `/${encodeURIComponent(notification.workCode)}?view=local`,
                            );
                          }}
                        >
                          {notification.status === "succeeded" ? (
                            notification.type === "remote_track" ? (
                              <GitBranchPlus className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                            ) : (
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                            )
                          ) : (
                            <Download className="mt-0.5 h-4 w-4 shrink-0 text-error" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{notification.message}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              Workflow #{notification.workflowRunId} · {notification.status}
                            </span>
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="m-1 h-8 w-8 shrink-0"
                          aria-label={`Dismiss notification for ${notification.workCode}`}
                          title="Dismiss notification"
                          onClick={() => void dismissFetchNotification(notification.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    {reviewRuns.map((run) => (
                      <button
                        key={`review-${run.id}`}
                        className="mb-1 flex w-full items-start gap-3 rounded-md p-2 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setReviewOpen(false);
                          onOpenPath(`/activity?view=review&run=${run.id}`);
                        }}
                      >
                        <Workflow className="mt-0.5 h-4 w-4 text-primary" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{run.displayName}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {run.workflowCode} · review
                          </span>
                        </span>
                        <Badge variant="warning">{workflowReviewCount(run)}</Badge>
                      </button>
                    ))}
                  </>
                )}
              </div>
              <PopoverFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setReviewOpen(false);
                    onOpenPath("/activity");
                  }}
                >
                  <Activity className="h-4 w-4" />
                  Open Activity
                </Button>
              </PopoverFooter>
            </div>
          </HeaderPopover>
        </div>
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
              {canRunWorkflows && canSyncMetadata && (
                <ActionItem
                  icon={<ScanLine className="h-4 w-4" />}
                  label="Scan local library"
                  busy={runningAction === "local_scan"}
                  onClick={() => void runSystemAction("local_scan")}
                />
              )}
              {canSyncMetadata && (
                <ActionItem
                  icon={<Database className="h-4 w-4" />}
                  label="Run DLsite sync"
                  busy={runningAction === "dlsite_sync"}
                  onClick={() => void runSystemAction("dlsite_sync")}
                />
              )}
              {canRunWorkflows && (
                <ActionItem
                  icon={<RotateCcw className="h-4 w-4" />}
                  label="Recover stale runs"
                  busy={runningAction === "recover_stale"}
                  onClick={() => void runSystemAction("recover_stale")}
                />
              )}
              <ActionItem
                icon={<Settings className="h-4 w-4" />}
                label="Open Settings"
                onClick={() => {
                  setActionsOpen(false);
                  onOpenPage("settings");
                }}
              />
              {canRunWorkflows && (
                <ActionItem
                  icon={<Workflow className="h-4 w-4" />}
                  label="Open Workflows"
                  onClick={() => {
                    setActionsOpen(false);
                    onOpenPage("workflows");
                  }}
                />
              )}
            </MenuList>
          </div>
        </HeaderPopover>
      </div>

      <div className="hidden sm:block">
        <HeaderPopover
          open={themeOpen}
          onOpenChange={setThemeOpen}
          trigger={<ThemeTrigger mode={themeMode} preset={themePreset} palette={themePalette} />}
          align="right"
        >
          <div className="w-64">
            <PopoverHeader title="Appearance" subtitle="Mode, style, and color" />
            <AppearanceControls
              mode={themeMode}
              preset={themePreset}
              palette={themePalette}
              onModeChange={setThemeMode}
              onPresetChange={setThemePreset}
              onPaletteChange={setThemePalette}
            />
          </div>
        </HeaderPopover>
      </div>

      <div className="hidden sm:block">
        {user ? (
          <HeaderPopover
            open={userOpen}
            onOpenChange={setUserOpen}
            trigger={
              <Button variant="outline" className="h-[var(--control-height)] gap-2 px-2 sm:px-3" aria-label="User menu">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {userInitial(user)}
                </span>
                <span className="hidden min-w-0 text-left sm:block">
                  <span className="block max-w-32 truncate text-xs font-medium leading-4">
                    {user.displayName || user.username}
                  </span>
                  <span className="block max-w-32 truncate text-[10px] leading-3 text-muted-foreground">
                    {user.role}
                    {user.devMode ? " · dev" : user.demoMode ? " · demo" : ""}
                  </span>
                </span>
                <ChevronDown className="hidden h-3.5 w-3.5 sm:block" />
              </Button>
            }
            align="right"
          >
            <div className="w-72">
              <div className="border-b p-3">
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                    {userInitial(user)}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{user.displayName || user.username}</div>
                    <div className="truncate text-xs text-muted-foreground">@{user.username}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge variant="outline">{user.role}</Badge>
                  {user.devMode && <Badge variant="warning">dev mode</Badge>}
                  {user.demoMode && <Badge variant="secondary">demo mode</Badge>}
                </div>
              </div>
              <MenuList>
                <ActionItem
                  icon={<Settings className="h-4 w-4" />}
                  label="Settings"
                  onClick={() => {
                    setUserOpen(false);
                    onOpenPage("settings");
                  }}
                />
                {canManageUsers && (
                  <ActionItem
                    icon={<Users className="h-4 w-4" />}
                    label="Users"
                    onClick={() => {
                      setUserOpen(false);
                      onOpenPath("/maintenance?tab=users");
                    }}
                  />
                )}
                {user.devMode || user.demoMode ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    {user.demoMode ? "Demo sessions are read-only." : "Dev mode session does not require sign out."}
                  </div>
                ) : (
                  <ActionItem
                    icon={<LogOut className="h-4 w-4" />}
                    label="Sign out"
                    onClick={() => {
                      setUserOpen(false);
                      onLogout();
                    }}
                  />
                )}
              </MenuList>
            </div>
          </HeaderPopover>
        ) : (
          <Button variant="outline" className="h-[var(--control-height)] gap-2 px-3" onClick={onOpenLogin}>
            <LogIn className="h-4 w-4" />
            <span className="hidden sm:inline">Sign in</span>
          </Button>
        )}
      </div>
    </div>
  );
}

function HeaderPopover({
  open,
  onOpenChange,
  trigger,
  children,
  align = "left",
  mobileSheet = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  children: ReactNode;
  align?: "left" | "right";
  mobileSheet?: boolean;
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
      {cloneElement(trigger, { onClick: () => onOpenChange(!open), "aria-expanded": open })}
      {open &&
        (mobileSheet ? (
          <div
            className="visual-viewport-layer z-[60] flex items-end bg-foreground/25 p-2 backdrop-blur-sm sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) onOpenChange(false);
            }}
          >
            <div
              data-android-back-close
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              className="theme-floating-surface flex min-h-0 w-full flex-col overflow-hidden rounded-t-xl border bg-card shadow-xl"
              style={{
                maxHeight: "calc(var(--visual-viewport-height) - 1rem)",
                paddingBottom: "max(0.5rem, var(--safe-area-bottom))",
              }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/35" aria-hidden="true" />
              {children}
            </div>
          </div>
        ) : (
          <div
            data-android-back-close
            className={cn(
              "theme-floating-surface absolute top-full z-50 mt-2 overflow-hidden rounded-lg border bg-card shadow-xl",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            {children}
          </div>
        ))}
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

function ActionItem({
  icon,
  label,
  busy,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="flex min-h-[var(--control-height)] w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted disabled:opacity-60"
      disabled={busy}
      onClick={onClick}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function workflowReviewCount(run: WorkflowRun) {
  return (
    run.pendingCandidates +
    run.skippedNodeRuns +
    run.skippedJobs +
    (run.status === "partial" || run.status === "skipped" ? 1 : 0)
  );
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
          {
            id: "activity:running",
            label: "Running runs",
            description: "Open current workflow activity",
            icon: <Activity className="h-4 w-4" />,
            run: () => onOpenPath("/activity"),
          },
          {
            id: "activity:review",
            label: "Review runs",
            description: "Open workflow runs needing review",
            icon: <ListChecks className="h-4 w-4" />,
            run: () => onOpenPath("/activity?view=review"),
          },
          {
            id: "activity:failed",
            label: "Failed runs",
            description: "Open failed workflow runs",
            icon: <Clock3 className="h-4 w-4" />,
            run: () => onOpenPath("/activity?view=failed"),
          },
        ]
      : []),
    ...(hasPermission("workflows:run") && hasPermission("metadata:sync")
      ? [
          {
            id: "action:local_scan",
            label: "Scan local library",
            description: "Scan local works and refresh local presence",
            icon: <ScanLine className="h-4 w-4" />,
            run: () => void api.runLocalScan({ followUpRun: false }).then(() => onOpenPath("/activity")),
          },
        ]
      : []),
    ...(hasPermission("workflows:run")
      ? [
          {
            id: "action:recover_stale",
            label: "Recover stale workflow runs",
            description: "Mark stale claimed jobs recoverable",
            icon: <RotateCcw className="h-4 w-4" />,
            run: () => void api.recoverStaleWorkflowRuns().then(() => onOpenPath("/activity")),
          },
        ]
      : []),
    ...(hasPermission("metadata:sync")
      ? [
          {
            id: "action:dlsite_sync",
            label: "Run DLsite sync",
            description: "Queue metadata synchronization",
            icon: <Play className="h-4 w-4" />,
            run: () => void api.runDLsiteSync().then(() => onOpenPath("/activity")),
          },
        ]
      : []),
  ];
}
