import { cloneElement, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Clock3,
  Download,
  GitBranchPlus,
  ListChecks,
  Loader2,
  LogIn,
  LogOut,
  RotateCcw,
  Server,
  Settings,
  Trash2,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";

import { type PageID } from "@/app/navigation";
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
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type CurrentUser, type WorkflowNotification, type WorkflowRun } from "@/lib/api";
import { clearStoredServerURL, getStoredServerURL, isNativeApp } from "@/lib/serverConfig";
import { versionLabel } from "@/lib/appInfo";
import { buildMobileDiagnosticsText } from "@/lib/mobileDiagnostics";
import { useMobileRuntime } from "@/app/MobileRuntime";
import type { UiLocale } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";

type HeaderActionsProps = {
  user: CurrentUser | null;
  hasPermission: (permission: string) => boolean;
  onLogout: () => void;
  onOpenLogin: () => void;
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
  onOpenCommandPalette: () => void;
  onLocaleChange: (locale: UiLocale) => Promise<void>;
};

export function HeaderActions({
  user,
  hasPermission,
  onLogout,
  onOpenLogin,
  onOpenPage,
  onOpenPath,
  onOpenCommandPalette,
  onLocaleChange,
}: HeaderActionsProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const canRunWorkflows = hasPermission("workflows:run");
  const canSyncMetadata = hasPermission("metadata:sync");
  const canManageUsers = hasPermission("users:manage");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [themePreset, setThemePreset] = useState<ThemePreset>(() => getStoredThemePreset());
  const [themePalette, setThemePalette] = useState<ThemePalette>(() => getStoredThemePalette());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("");
  const [diagnosticsText, setDiagnosticsText] = useState("");
  const [themeOpen, setThemeOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [mobileAppearanceOpen, setMobileAppearanceOpen] = useState(false);
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false);
  const [localeBusy, setLocaleBusy] = useState(false);
  const [localeError, setLocaleError] = useState("");
  const [reviewRuns, setReviewRuns] = useState<WorkflowRun[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [notifications, setNotifications] = useState<WorkflowNotification[]>([]);
  const [notificationCount, setNotificationCount] = useState(0);
  const [notificationPage, setNotificationPage] = useState(1);
  const [notificationTotalPages, setNotificationTotalPages] = useState(1);
  const [clearableNotificationCount, setClearableNotificationCount] = useState(0);
  const [clearingSucceeded, setClearingSucceeded] = useState(false);
  const mobileRuntime = useMobileRuntime();
  const locale = useLocale();

  const changeLocale = async (next: UiLocale) => {
    if (localeBusy || next === locale.preference) return;
    setLocaleBusy(true);
    setLocaleError("");
    try {
      await onLocaleChange(next);
    } catch {
      setLocaleError(t("appearance.saveFailed"));
    } finally {
      setLocaleBusy(false);
    }
  };

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

  const notificationPageSize = 50;
  const refreshNotificationCenter = (requestedPage = notificationPage) => {
    if (user) {
      api
        .listNotifications(requestedPage, notificationPageSize)
        .then((page) => {
          setNotifications(page.notifications);
          setNotificationCount(page.total);
          setNotificationPage(page.page);
          setNotificationTotalPages(page.totalPages);
          setClearableNotificationCount(page.clearableTotal);
        })
        .catch(() => {
          setNotifications([]);
          setNotificationCount(0);
          setNotificationPage(1);
          setNotificationTotalPages(1);
          setClearableNotificationCount(0);
        });
    } else {
      setNotifications([]);
      setNotificationCount(0);
      setNotificationPage(1);
      setNotificationTotalPages(1);
      setClearableNotificationCount(0);
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
  }, [canRunWorkflows, notificationPage, user?.id]);

  const totalNotificationCount = notificationCount + reviewCount;

  const dismissFetchNotification = async (id: number) => {
    const previous = notifications;
    const previousCount = notificationCount;
    const dismissed = notifications.find((item) => item.id === id);
    setNotifications((items) => items.filter((item) => item.id !== id));
    setNotificationCount((count) => Math.max(0, count - 1));
    if (dismissed?.status === "succeeded") setClearableNotificationCount((count) => Math.max(0, count - 1));
    try {
      await api.dismissNotification(id);
    } catch {
      setNotifications(previous);
      setNotificationCount(previousCount);
      if (dismissed?.status === "succeeded") setClearableNotificationCount((count) => count + 1);
    }
  };

  const clearSucceededNotifications = async () => {
    if (clearingSucceeded || clearableNotificationCount === 0) return;
    setClearingSucceeded(true);
    try {
      await api.clearSucceededNotifications();
      setNotificationPage(1);
      await refreshNotificationCenter(1);
    } catch (error) {
      toast.notify(toastFromError(error, t("notifications.clearFailed")));
    } finally {
      setClearingSucceeded(false);
    }
  };

  const checkConnection = async () => {
    setConnectionStatus(t("common.checking"));
    const health = await mobileRuntime.reconnect();
    setConnectionStatus(
      health
        ? t("account.connectedVersion", { version: health.version })
        : mobileRuntime.connection.message || t("common.connectionCheckFailed"),
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
        aria-label={t("header.quickActions")}
        title={t("header.quickActions")}
        className="order-1 h-11 w-11 sm:h-[var(--control-icon-size)] sm:w-[var(--control-icon-size)]"
        onClick={onOpenCommandPalette}
      >
        <Zap className="h-4 w-4" />
      </Button>

      <div className="order-3 sm:hidden">
        <HeaderPopover
          open={mobileAppearanceOpen}
          onOpenChange={setMobileAppearanceOpen}
          trigger={<ThemeTrigger mode={themeMode} preset={themePreset} palette={themePalette} />}
          align="right"
          ariaLabel={t("appearance.title")}
        >
          <div className="w-[min(16rem,calc(100vw-1rem))]">
            <div className="app-scroll max-h-[calc(var(--visual-viewport-height)-4rem)] overflow-y-auto">
              <PopoverHeader title={t("appearance.title")} subtitle={t("appearance.subtitle")} />
              <AppearanceControls
                mode={themeMode}
                preset={themePreset}
                palette={themePalette}
                onModeChange={setThemeMode}
                onPresetChange={setThemePreset}
                onPaletteChange={setThemePalette}
                localePreference={locale.preference}
                onLocaleChange={changeLocale}
                localeBusy={localeBusy}
                localeError={localeError}
              />
            </div>
          </div>
        </HeaderPopover>
      </div>

      <div className="order-4 sm:hidden">
        <HeaderPopover
          open={mobileAccountOpen}
          onOpenChange={setMobileAccountOpen}
          trigger={
            user ? (
              <Button
                variant="outline"
                size="icon"
                aria-label={t("account.accountMenu")}
                title={t("account.accountMenu")}
                className="relative h-11 w-11"
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {userInitial(user)}
                </span>
              </Button>
            ) : (
              <Button
                variant="outline"
                size="icon"
                aria-label={t("account.signIn")}
                title={t("account.signIn")}
                className="h-11 w-11"
              >
                <LogIn className="h-4 w-4" />
              </Button>
            )
          }
          align="right"
          ariaLabel={t("account.account")}
        >
          <div className="w-[min(20rem,calc(100vw-1rem))]">
            <div className="app-scroll max-h-[calc(var(--visual-viewport-height)-4rem)] overflow-y-auto">
              <PopoverHeader
                title={t("account.account")}
                subtitle={user ? user.displayName || user.username : t("account.accountSubtitle")}
              />
              {user && (
                <MenuList>
                  {canRunWorkflows && (
                    <>
                      <ActionItem
                        icon={<Activity className="h-4 w-4" />}
                        label={t("account.activity")}
                        onClick={() => {
                          setMobileAccountOpen(false);
                          onOpenPath("/activity");
                        }}
                      />
                      <ActionItem
                        icon={<ListChecks className="h-4 w-4" />}
                        label={reviewCount > 0 ? t("account.reviewCount", { count: reviewCount }) : t("account.review")}
                        onClick={() => {
                          setMobileAccountOpen(false);
                          onOpenPath("/activity?view=review");
                        }}
                      />
                    </>
                  )}
                  <ActionItem
                    icon={<Settings className="h-4 w-4" />}
                    label={t("account.settings")}
                    onClick={() => {
                      setMobileAccountOpen(false);
                      onOpenPage("settings");
                    }}
                  />
                  {canManageUsers && (
                    <ActionItem
                      icon={<Users className="h-4 w-4" />}
                      label={t("account.users")}
                      onClick={() => {
                        setMobileAccountOpen(false);
                        onOpenPath("/maintenance?tab=users");
                      }}
                    />
                  )}
                </MenuList>
              )}
              {isNativeApp() && (
                <div className="border-t p-2">
                  <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t("account.server")}</div>
                  <ActionItem
                    icon={<Server className="h-4 w-4" />}
                    label={t("account.reconnect")}
                    onClick={() => void checkConnection()}
                  />
                  <ActionItem
                    icon={<Clipboard className="h-4 w-4" />}
                    label={t("account.copyDiagnostics")}
                    onClick={() => void showDiagnostics()}
                  />
                  <ActionItem
                    icon={<RotateCcw className="h-4 w-4" />}
                    label={t("account.clearServer")}
                    onClick={() => {
                      setMobileAccountOpen(false);
                      clearStoredServerURL();
                      window.location.reload();
                    }}
                  />
                </div>
              )}
              {user ? (
                !user.devMode &&
                !user.demoMode && (
                  <div className="border-t p-2">
                    <ActionItem
                      icon={<LogOut className="h-4 w-4" />}
                      label={t("account.signOut")}
                      onClick={() => {
                        setMobileAccountOpen(false);
                        onLogout();
                      }}
                    />
                  </div>
                )
              ) : (
                <div className="border-t p-2">
                  <ActionItem
                    icon={<LogIn className="h-4 w-4" />}
                    label={t("account.signIn")}
                    onClick={() => {
                      setMobileAccountOpen(false);
                      onOpenLogin();
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </HeaderPopover>
      </div>

      {isNativeApp() && (
        <div className="order-2 hidden sm:block">
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
              <Button
                variant="outline"
                size="icon"
                aria-label={t("account.serverConnection")}
                title={t("account.serverConnection")}
              >
                <Server className="h-4 w-4" />
              </Button>
            }
            align="right"
          >
            <div className="w-80">
              <PopoverHeader title={t("account.connection")} subtitle={t("account.androidClientServer")} />
              <div className="space-y-3 border-b p-3 text-sm">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">{t("account.server")}</div>
                  <div className="mt-1 break-all font-medium">{getStoredServerURL() || t("common.notConfigured")}</div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md border bg-muted px-2 py-1.5">
                    <div className="text-muted-foreground">{t("account.client")}</div>
                    <div className="truncate font-medium">{versionLabel()}</div>
                  </div>
                  <div className="rounded-md border bg-muted px-2 py-1.5">
                    <div className="text-muted-foreground">{t("account.server")}</div>
                    <div className="truncate font-medium">
                      {mobileRuntime.connection.serverVersion || t("common.unknown")}
                    </div>
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
                  label={t("account.reconnect")}
                  onClick={() => void checkConnection()}
                />
                {user && (
                  <ActionItem
                    icon={<LogOut className="h-4 w-4" />}
                    label={t("account.signOut")}
                    onClick={() => {
                      setConnectionOpen(false);
                      onLogout();
                    }}
                  />
                )}
                <ActionItem
                  icon={<RotateCcw className="h-4 w-4" />}
                  label={t("account.clearServer")}
                  onClick={() => {
                    clearStoredServerURL();
                    window.location.reload();
                  }}
                />
                <ActionItem
                  icon={<Clipboard className="h-4 w-4" />}
                  label={t("account.copyDiagnostics")}
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
        <div className="order-2 sm:order-3">
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
                aria-label={t("notifications.title")}
                title={t("notifications.title")}
                className="relative h-11 w-11 sm:h-[var(--control-icon-size)] sm:w-[var(--control-icon-size)]"
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
            ariaLabel={t("notifications.title")}
          >
            <div className="w-[min(22rem,calc(100vw-1rem))] max-w-full">
              <PopoverHeader
                title={t("notifications.title")}
                subtitle={
                  totalNotificationCount > 0
                    ? t("notifications.itemCount", { count: totalNotificationCount })
                    : t("notifications.nothingNew")
                }
              />
              <div className="app-scroll max-h-[min(24rem,calc(var(--visual-viewport-height)-8rem))] overflow-auto p-2">
                {notifications.length === 0 && reviewRuns.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    {t("notifications.empty")}
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
                            if (notification.type === "availability_watch_ready") {
                              onOpenPath(
                                `/workflows?workflow=availability_watch&dialog=ready&run=${notification.workflowRunId}`,
                              );
                              return;
                            }
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
                          {notification.type === "availability_watch_ready" ? (
                            <Bell className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                          ) : notification.status === "succeeded" ? (
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
                              {t("notifications.workflowStatus", {
                                id: notification.workflowRunId,
                                status: notification.status,
                              })}
                            </span>
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="m-1 h-8 w-8 shrink-0"
                          aria-label={t("notifications.dismissFor", { workCode: notification.workCode })}
                          title={t("notifications.dismiss")}
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
                            {run.workflowCode} · {t("account.review")}
                          </span>
                        </span>
                        <Badge variant="warning">{workflowReviewCount(run)}</Badge>
                      </button>
                    ))}
                  </>
                )}
              </div>
              {notificationTotalPages > 1 && (
                <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
                  <span>
                    {t("notifications.pageOf", { page: notificationPage, totalPages: notificationTotalPages })}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={notificationPage <= 1}
                      aria-label={t("collection.previousPage")}
                      title={t("collection.previousPage")}
                      onClick={() => setNotificationPage((page) => Math.max(1, page - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={notificationPage >= notificationTotalPages}
                      aria-label={t("collection.nextPage")}
                      title={t("collection.nextPage")}
                      onClick={() => setNotificationPage((page) => Math.min(notificationTotalPages, page + 1))}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
              <PopoverFooter>
                <div className="flex w-full items-center justify-between gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={clearingSucceeded || clearableNotificationCount === 0}
                    onClick={() => void clearSucceededNotifications()}
                  >
                    {clearingSucceeded ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    {t("notifications.clearSucceeded")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setReviewOpen(false);
                      onOpenPath("/activity");
                    }}
                  >
                    <Activity className="h-4 w-4" />
                    {t("notifications.openActivity")}
                  </Button>
                </div>
              </PopoverFooter>
            </div>
          </HeaderPopover>
        </div>
      )}

      <div className="order-4 hidden sm:block">
        <HeaderPopover
          open={themeOpen}
          onOpenChange={setThemeOpen}
          trigger={<ThemeTrigger mode={themeMode} preset={themePreset} palette={themePalette} />}
          align="right"
        >
          <div className="w-64">
            <div className="app-scroll max-h-[calc(var(--visual-viewport-height)-4rem)] overflow-y-auto">
              <PopoverHeader title={t("appearance.title")} subtitle={t("appearance.subtitle")} />
              <AppearanceControls
                mode={themeMode}
                preset={themePreset}
                palette={themePalette}
                onModeChange={setThemeMode}
                onPresetChange={setThemePreset}
                onPaletteChange={setThemePalette}
                localePreference={locale.preference}
                onLocaleChange={changeLocale}
                localeBusy={localeBusy}
                localeError={localeError}
              />
            </div>
          </div>
        </HeaderPopover>
      </div>

      <div className="order-5 hidden sm:block">
        {user ? (
          <HeaderPopover
            open={userOpen}
            onOpenChange={setUserOpen}
            trigger={
              <Button
                variant="outline"
                className="h-[var(--control-height)] gap-2 px-2 sm:px-3"
                aria-label={t("account.userMenu")}
              >
                <span className="grid h-6 w-6 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {userInitial(user)}
                </span>
                <span className="hidden min-w-0 text-left sm:block">
                  <span className="block max-w-32 truncate text-xs font-medium leading-4">
                    {user.displayName || user.username}
                  </span>
                  <span className="block max-w-32 truncate text-[10px] leading-3 text-muted-foreground">
                    {t(`account.roles.${user.role}`, { defaultValue: user.role })}
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
                  <Badge variant="outline">{t(`account.roles.${user.role}`, { defaultValue: user.role })}</Badge>
                  {user.devMode && <Badge variant="warning">{t("account.devMode")}</Badge>}
                  {user.demoMode && <Badge variant="secondary">{t("account.demoMode")}</Badge>}
                </div>
              </div>
              <MenuList>
                <ActionItem
                  icon={<Settings className="h-4 w-4" />}
                  label={t("account.settings")}
                  onClick={() => {
                    setUserOpen(false);
                    onOpenPage("settings");
                  }}
                />
                {canManageUsers && (
                  <ActionItem
                    icon={<Users className="h-4 w-4" />}
                    label={t("account.users")}
                    onClick={() => {
                      setUserOpen(false);
                      onOpenPath("/maintenance?tab=users");
                    }}
                  />
                )}
                {user.devMode || user.demoMode ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    {user.demoMode ? t("account.demoSessionReadOnly") : t("account.devSessionNoSignOut")}
                  </div>
                ) : (
                  <ActionItem
                    icon={<LogOut className="h-4 w-4" />}
                    label={t("account.signOut")}
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
            <span className="hidden sm:inline">{t("account.signIn")}</span>
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
  ariaLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  children: ReactNode;
  align?: "left" | "right";
  ariaLabel?: string;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [bottomCollisionPadding, setBottomCollisionPadding] = useState(12);

  useEffect(() => {
    if (!open) return;
    const updatePlayerBoundary = () => {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const player = document.querySelector<HTMLElement>('[data-compact-player="true"]');
      if (!player || document.documentElement.dataset.playerMode !== "compact") {
        setBottomCollisionPadding(12);
        return;
      }
      const playerTop = player.getBoundingClientRect().top;
      const overlap = viewportBottom - playerTop;
      setBottomCollisionPadding(Math.max(12, overlap + 8));
    };

    updatePlayerBoundary();
    const player = document.querySelector<HTMLElement>('[data-compact-player="true"]');
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !player ? null : new ResizeObserver(updatePlayerBoundary);
    if (resizeObserver && player) resizeObserver.observe(player);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(updatePlayerBoundary);
    mutationObserver?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", updatePlayerBoundary);
    window.visualViewport?.addEventListener("resize", updatePlayerBoundary);
    window.visualViewport?.addEventListener("scroll", updatePlayerBoundary);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", updatePlayerBoundary);
      window.visualViewport?.removeEventListener("resize", updatePlayerBoundary);
      window.visualViewport?.removeEventListener("scroll", updatePlayerBoundary);
    };
  }, [open]);

  return (
    <div className="relative" ref={anchorRef}>
      {cloneElement(trigger, { onClick: () => onOpenChange(!open), "aria-expanded": open })}
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        align={align === "right" ? "end" : "start"}
        collisionPadding={8}
        bottomCollisionPadding={bottomCollisionPadding}
        ariaLabel={ariaLabel}
        onOpenChange={onOpenChange}
        className="max-w-[calc(100vw-1rem)] bg-card"
      >
        {children}
      </AnchoredPopover>
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
