import { metadataIssuesURL, metadataSyncResultURL } from "@/lib/metadataMaintenance";
import { cloneElement, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Download,
  GitBranchPlus,
  ListChecks,
  Loader2,
  LogIn,
  LogOut,
  RotateCcw,
  Search,
  Server,
  Settings,
  Trash2,
  Users,
  Workflow,
  X,
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
import { useMetadataDisplayLanguage } from "@/features/maintenance/useMetadataDisplayLanguage";
import { Badge } from "@/components/ui/badge";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type CurrentUser, type WorkflowNotification, type WorkflowRun } from "@/lib/api";
import { clearStoredServerURL, getStoredServerURL, isNativeApp } from "@/lib/serverConfig";
import { versionLabel } from "@/lib/appInfo";
import { cn } from "@/lib/tailwindClassNames";
import { buildMobileDiagnosticsText } from "@/lib/mobileDiagnostics";
import { useMobileRuntime } from "@/app/MobileRuntime";
import type { UiLocale } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { PERSONAL_TAB_PERMISSION, personalTabPath, personalTabs } from "@/pages/personalTabs";

type HeaderActionsProps = {
  user: CurrentUser | null;
  /** Gates navigation and read-only views; Demo can open every surface it cannot change. */
  canView: (permission: string) => boolean;
  onLogout: () => void;
  onOpenLogin: () => void;
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
  onOpenCommandPalette: () => void;
  onLocaleChange: (locale: UiLocale) => Promise<void>;
};

// Icon controls inside the header tray: 44px on mobile, compact and round on
// wider screens where the tray border groups them.
const trayButtonClass =
  "h-11 w-11 rounded-full text-muted-foreground hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground sm:h-8 sm:w-8";

const commandShortcutLabel =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "\u2318K" : "Ctrl K";

// Personal tabs stay out of the four bottom tabs; the mobile account surface
// reaches each one directly next to Settings.

export function HeaderActions({
  user,
  canView,
  onLogout,
  onOpenLogin,
  onOpenPage,
  onOpenPath,
  onOpenCommandPalette,
  onLocaleChange,
}: HeaderActionsProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const canViewWorkflows = canView("workflows:run");
  const canViewMetadataIssues = canView("metadata:sync");
  const canViewUsers = canView("users:manage");
  // Every signed-in user chooses an own metadata language; anonymous visitors
  // see the instance default.
  const canViewMetadataLanguage = Boolean(user);
  const readOnly = user?.demoMode ?? false;
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
  const metadataDisplayLanguage = useMetadataDisplayLanguage(
    canViewMetadataLanguage && (themeOpen || mobileAppearanceOpen),
    user?.id ?? null,
  );
  const metadataLanguageControl = canViewMetadataLanguage
    ? {
        value: metadataDisplayLanguage.value,
        busy: metadataDisplayLanguage.busy,
        failed: metadataDisplayLanguage.failed,
        readOnly,
        onChange: metadataDisplayLanguage.change,
      }
    : undefined;

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
  // Stable so the polling effect below re-subscribes only when the viewer,
  // workflow visibility, or page changes, while each poll reads current state.
  const refreshNotificationCenter = useStableCallback((requestedPage: number = notificationPage) => {
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
    if (canViewWorkflows) {
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
  });

  const userId = user?.id ?? null;
  useEffect(() => {
    refreshNotificationCenter();
    if (userId === null && !canViewWorkflows) return;
    // Background tabs and a backgrounded native app skip polling and catch up on return.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshNotificationCenter();
    }, 30000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshNotificationCenter();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [canViewWorkflows, notificationPage, refreshNotificationCenter, userId]);

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

  const clearMobileServer = async () => {
    try {
      await clearStoredServerURL();
      window.location.reload();
    } catch (error) {
      toast.notify(toastFromError(error, t("serverGate.settingsUnavailable")));
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
      <button
        type="button"
        aria-label={t("header.quickActions")}
        title={t("header.quickActions")}
        className="order-1 hidden h-[var(--control-height)] w-52 items-center gap-2 rounded-full border bg-background/70 pl-3 pr-1.5 text-sm text-muted-foreground transition-[color,background-color,border-color,transform] hover:border-ring/40 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100 md:flex md:w-44 xl:w-72"
        onClick={onOpenCommandPalette}
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{t("commands.searchPlaceholder")}</span>
        <kbd className="hidden shrink-0 rounded-full border bg-card px-2 py-0.5 font-sans text-3xs font-medium leading-4 text-muted-foreground xl:inline">
          {commandShortcutLabel}
        </kbd>
      </button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("header.quickActions")}
        title={t("header.quickActions")}
        className={cn(trayButtonClass, "order-1 md:hidden")}
        onClick={onOpenCommandPalette}
      >
        <Search className="h-4 w-4" />
      </Button>

      <div className="order-3 sm:hidden">
        <HeaderPopover
          open={mobileAppearanceOpen}
          onOpenChange={setMobileAppearanceOpen}
          trigger={
            <ThemeTrigger
              mode={themeMode}
              preset={themePreset}
              palette={themePalette}
              variant="ghost"
              className={trayButtonClass}
            />
          }
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
                metadataLanguage={metadataLanguageControl}
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
                variant="ghost"
                size="icon"
                aria-label={t("account.accountMenu")}
                title={t("account.accountMenu")}
                className="relative h-11 w-11 rounded-full aria-expanded:bg-muted"
              >
                <UserAvatar user={user} className="h-8 w-8 text-xs" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("account.signIn")}
                title={t("account.signIn")}
                className={trayButtonClass}
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
                  {canViewWorkflows && (
                    <>
                      <ActionItem
                        icon={<Activity className="h-4 w-4" />}
                        label={t("account.activity")}
                        onClick={() => {
                          setMobileAccountOpen(false);
                          onOpenPath("/workflows?activity=1");
                        }}
                      />
                      <ActionItem
                        icon={<ListChecks className="h-4 w-4" />}
                        label={reviewCount > 0 ? t("account.reviewCount", { count: reviewCount }) : t("account.review")}
                        onClick={() => {
                          setMobileAccountOpen(false);
                          onOpenPath("/workflows?activity=1&view=review");
                        }}
                      />
                    </>
                  )}
                  {canView(PERSONAL_TAB_PERMISSION) &&
                    personalTabs.map((tab) => (
                      <ActionItem
                        key={tab.id}
                        icon={<tab.icon className="h-4 w-4" />}
                        label={t(tab.labelKey)}
                        onClick={() => {
                          setMobileAccountOpen(false);
                          onOpenPath(personalTabPath(tab.id));
                        }}
                      />
                    ))}
                  <ActionItem
                    icon={<Settings className="h-4 w-4" />}
                    label={t("account.settings")}
                    onClick={() => {
                      setMobileAccountOpen(false);
                      onOpenPage("settings");
                    }}
                  />
                  {canViewUsers && (
                    <ActionItem
                      icon={<Users className="h-4 w-4" />}
                      label={t("account.users")}
                      onClick={() => {
                        setMobileAccountOpen(false);
                        onOpenPath("/settings?tab=users");
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
                      void clearMobileServer();
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

      <div className="contents sm:order-2 sm:flex sm:items-center sm:gap-0.5 sm:rounded-full sm:border sm:bg-background/70 sm:p-0.5">
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
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("account.serverConnection")}
                  title={t("account.serverConnection")}
                  className={trayButtonClass}
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
                    <div className="mt-1 break-all font-medium">
                      {getStoredServerURL() || t("common.notConfigured")}
                    </div>
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
                      void clearMobileServer();
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
          <div className="order-2 sm:order-none">
            <HeaderPopover
              open={reviewOpen}
              onOpenChange={(open) => {
                setReviewOpen(open);
                if (open) refreshNotificationCenter();
              }}
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("notifications.title")}
                  title={t("notifications.title")}
                  className={cn(trayButtonClass, "relative")}
                >
                  <Bell className="h-4 w-4" />
                  {totalNotificationCount > 0 && (
                    <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-3xs font-semibold leading-none text-primary-foreground ring-2 ring-card sm:-right-0.5 sm:-top-0.5">
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
                              if (notification.type === "metadata_onboarding") {
                                onOpenPath(
                                  canViewMetadataIssues
                                    ? metadataSyncResultURL(
                                        notification.workflowRunId,
                                        notification.status !== "succeeded",
                                        canViewWorkflows,
                                      )
                                    : canViewWorkflows
                                      ? `/workflows?activity=1&run=${notification.workflowRunId}`
                                      : "/",
                                );
                                return;
                              }
                              if (notification.type === "availability_watch_ready") {
                                onOpenPath(
                                  `/workflows?workflow=availability_watch&dialog=ready&run=${notification.workflowRunId}`,
                                );
                                return;
                              }
                              if (notification.type === "remote_track" && notification.status === "failed") {
                                if (canViewWorkflows)
                                  onOpenPath(`/workflows?activity=1&run=${notification.workflowRunId}`);
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
                              <span className="block truncate font-medium">{notificationTitle(notification, t)}</span>
                              {notification.type === "metadata_onboarding" && (
                                <span className="block text-xs text-muted-foreground">
                                  {t(
                                    notification.status === "succeeded"
                                      ? "metadataOnboarding.complete"
                                      : "metadataOnboarding.partial",
                                  )}
                                </span>
                              )}
                              <span className="block truncate text-xs text-muted-foreground">
                                {t("notifications.workflowStatus", {
                                  id: notification.workflowRunId,
                                  status: notificationStatusLabel(notification.status, t),
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
                            disabled={readOnly}
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
                            onOpenPath(
                              canViewMetadataIssues && (run.pendingMetadata ?? 0) > 0
                                ? metadataIssuesURL(run.id)
                                : `/workflows?activity=1&view=review&run=${run.id}`,
                            );
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
                      disabled={readOnly || clearingSucceeded || clearableNotificationCount === 0}
                      onClick={() => void clearSucceededNotifications()}
                    >
                      {clearingSucceeded ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                      {t("notifications.clearSucceeded")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setReviewOpen(false);
                        onOpenPath("/workflows?activity=1");
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

        <div className="hidden sm:block">
          <HeaderPopover
            open={themeOpen}
            onOpenChange={setThemeOpen}
            trigger={
              <ThemeTrigger
                mode={themeMode}
                preset={themePreset}
                palette={themePalette}
                variant="ghost"
                className={trayButtonClass}
              />
            }
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
                  metadataLanguage={metadataLanguageControl}
                />
              </div>
            </div>
          </HeaderPopover>
        </div>
      </div>

      <span aria-hidden="true" className="order-3 hidden h-5 w-px bg-border sm:block" />

      <div className="order-4 hidden sm:block">
        {user ? (
          <HeaderPopover
            open={userOpen}
            onOpenChange={setUserOpen}
            trigger={
              <Button
                variant="ghost"
                className="h-[var(--control-height)] gap-2 rounded-full px-1 aria-expanded:bg-muted xl:pr-2.5"
                aria-label={t("account.userMenu")}
              >
                <UserAvatar user={user} className="h-8 w-8 text-xs" />
                <span className="hidden min-w-0 text-left xl:block">
                  <span className="block max-w-32 truncate text-xs font-medium leading-4">
                    {user.displayName || user.username}
                  </span>
                  <span className="block max-w-32 truncate text-3xs leading-3 text-muted-foreground">
                    {t(`account.roles.${user.role}`, { defaultValue: user.role })}
                    {user.devMode ? " · dev" : user.demoMode ? " · demo" : ""}
                  </span>
                </span>
                <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground xl:block" />
              </Button>
            }
            align="right"
          >
            <div className="w-72">
              <div className="border-b p-3">
                <div className="flex items-center gap-3">
                  <UserAvatar user={user} className="h-10 w-10 text-sm" />
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
                {canViewUsers && (
                  <ActionItem
                    icon={<Users className="h-4 w-4" />}
                    label={t("account.users")}
                    onClick={() => {
                      setUserOpen(false);
                      onOpenPath("/settings?tab=users");
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
          <Button className="h-[var(--control-height)] gap-2 rounded-full px-4" onClick={onOpenLogin}>
            <LogIn className="h-4 w-4" />
            {t("account.signIn")}
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
  trigger: ReactElement<{ onClick?: () => void; "aria-expanded"?: boolean }>;
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

function notificationTitle(notification: WorkflowNotification, t: TFunction) {
  if (notification.type === "metadata_onboarding") {
    return t(notification.status === "succeeded" ? "metadataOnboarding.succeeded" : "metadataOnboarding.attention");
  }
  if (notification.type === "availability_watch_ready") {
    return t("notifications.availabilityReady", { workCode: notification.workCode });
  }
  if (notification.type === "remote_track") {
    return notification.status === "failed"
      ? t("notifications.remoteTrackFailed", { workCode: notification.workCode })
      : t("notifications.remoteTrackSucceeded", { workCode: notification.workCode });
  }
  return t("notifications.generic", { workCode: notification.workCode });
}

function notificationStatusLabel(status: string, t: TFunction) {
  const key =
    status === "queued"
      ? "notifications.statusQueued"
      : status === "running"
        ? "notifications.statusRunning"
        : status === "succeeded"
          ? "notifications.statusSucceeded"
          : status === "failed"
            ? "notifications.statusFailed"
            : status === "cancelled"
              ? "notifications.statusCancelled"
              : "notifications.statusUnknown";
  return t(key);
}

function UserAvatar({ user, className }: { user: CurrentUser; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-primary/15 font-semibold text-primary ring-1 ring-inset ring-primary/25",
        className,
      )}
    >
      {userInitial(user)}
    </span>
  );
}

function userInitial(user: CurrentUser) {
  return (user.displayName || user.username || "U").trim().slice(0, 1).toUpperCase();
}
