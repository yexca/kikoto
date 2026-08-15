import { App as CapacitorApp } from "@capacitor/app";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  WifiOff,
  X,
} from "lucide-react";

import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import {
  canAccessPage,
  navItems,
  navigationDescription,
  navigationLabel,
  visibleNavigationItems,
  type PageID,
} from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { LoginPage } from "@/pages/LoginPage";
import { cn } from "@/lib/utils";
import { PlayerDock, PlayerProvider } from "@/player/PlayerProvider";
import { HeaderActions } from "@/app/HeaderActions";
import { CommandPalette } from "@/app/CommandPalette";
import { NotFoundPage } from "@/app/NotFoundPage";
import { RouteErrorBoundary } from "@/app/RouteErrorBoundary";
import { useScrollRestoration } from "@/app/scrollRestoration";
import { MobileRuntimeProvider, useMobileRuntime } from "@/app/MobileRuntime";
import { ANDROID_BACK_EVENT, LOGIN_REQUEST_EVENT } from "@/app/events";
import { isNativeApp } from "@/lib/serverConfig";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { isWorkCodePath } from "@/lib/workCode";
import { useLocale } from "@/i18n/LocaleProvider";
import type { UiLocale } from "@/i18n";
import {
  HISTORY_ENTRY_UPDATED_EVENT,
  NAVIGATION_EVENT,
  currentInternalLocation,
  historyScrollY,
  mobileTabResumeHistoryState,
  navigateToWorkspaceUp,
  requestHistoryScrollRestoration,
} from "@/lib/browserHistory";
import { api, type RemoteTrackRunStatus } from "@/lib/api";
import { normalizeLibraryBrowseLocation, readLastLibraryLocation } from "@/pages/libraryBrowseState";
import { isCircleListLocation, readLastCircleListLocation } from "@/pages/circleNavigationState";
import { isVoiceListLocation, readLastVoiceListLocation } from "@/pages/voiceNavigationState";
import { legacyLibraryRedirect } from "@/app/legacyLibraryRoutes";
import { readMobileTabSnapshot, writeMobileTabSnapshot } from "@/app/mobileTabState";
import {
  REMOTE_TRACK_CREATED_EVENT,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackCreatedDetail,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";

const LibraryPage = lazy(() => import("@/pages/LibraryPage").then((module) => ({ default: module.LibraryPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const MaintenancePage = lazy(() =>
  import("@/pages/MaintenancePage").then((module) => ({ default: module.MaintenancePage })),
);
const WorkflowsPage = lazy(() => import("@/pages/WorkflowsPage").then((module) => ({ default: module.WorkflowsPage })));
const FavoritesPage = lazy(() => import("@/pages/FavoritesPage").then((module) => ({ default: module.FavoritesPage })));
const CreatorWorksPage = lazy(() =>
  import("@/pages/CreatorWorksPage").then((module) => ({ default: module.CreatorWorksPage })),
);
const CirclesPage = lazy(() => import("@/pages/CirclesPage").then((module) => ({ default: module.CirclesPage })));
const AboutPage = lazy(() => import("@/pages/AboutPage").then((module) => ({ default: module.AboutPage })));

const preferredMobileTabs: PageID[] = ["library", "favorites", "circles", "voice-actors"];
const SIDEBAR_COLLAPSED_KEY = "kikoto:sidebar-collapsed";
type AppPage = PageID | "not-found";

export function App() {
  return (
    <MobileRuntimeProvider>
      <AuthProvider>
        <AuthenticatedApp />
      </AuthProvider>
    </MobileRuntimeProvider>
  );
}

function AuthenticatedApp() {
  useScrollRestoration();
  const auth = useAuth();
  const { t } = useTranslation();
  const locale = useLocale();
  const [page, setPage] = useState<AppPage>(resolveAppPageFromLocation);
  const [routeRenderKey, setRouteRenderKey] = useState(resolveRouteRenderKey);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
  );
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteBusy, setCommandPaletteBusy] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const mobileRuntime = useMobileRuntime();
  const toast = useToast();
  const exitBackDeadlineRef = useRef(0);
  const authState = auth.user ? "authenticated" : "anonymous";
  const clientStorageScope = currentClientStorageScope(auth.user?.id ?? null);

  useEffect(() => {
    locale.syncAccountPreference(auth.user?.id ?? null, auth.user?.uiLocale, auth.user?.demoMode ?? false);
  }, [auth.user?.demoMode, auth.user?.id, auth.user?.uiLocale, locale.syncAccountPreference]);

  const updateLocale = useCallback(
    async (next: UiLocale) => {
      const previous = locale.preference;
      locale.setPreference(next);
      if (!auth.user || auth.demoMode) return;
      try {
        const state = await api.updateCurrentAccount({ uiLocale: next });
        if (!state.authenticated) throw new Error("Language preference could not be saved.");
        locale.setPreference(state.user.uiLocale);
        await auth.refresh();
      } catch (error) {
        locale.setPreference(previous);
        throw error;
      }
    },
    [auth.demoMode, auth.refresh, auth.user, locale],
  );
  const effectiveHasPermission = useCallback(
    (permission: string) => !auth.demoMode && auth.hasPermission(permission),
    [auth.demoMode, auth.hasPermission],
  );
  const navigationHasPermission = useCallback(
    (permission: string) => auth.demoMode || auth.hasPermission(permission),
    [auth.demoMode, auth.hasPermission],
  );
  const visibleNavItems = useMemo(
    () => visibleNavigationItems({ state: authState, hasPermission: navigationHasPermission }),
    [authState, navigationHasPermission],
  );
  const mobileNavItems = useMemo(() => {
    const preferred = preferredMobileTabs
      .map((id) => visibleNavItems.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (preferred.length >= 4) return preferred.slice(0, 4);
    const additions = visibleNavItems.filter((item) => !preferred.some((candidate) => candidate.id === item.id));
    return [...preferred, ...additions].slice(0, 4);
  }, [visibleNavItems]);
  const showMobilePageTitle = !["library", "favorites", "circles", "voice-actors"].includes(page);
  const activeItem = useMemo(() => visibleNavItems.find((item) => item.id === page), [page, visibleNavItems]);
  const canAccessCurrentPage = page !== "not-found" && canAccessPage(page, authState, navigationHasPermission);

  useEffect(() => {
    const syncLocation = () => {
      setPage(resolveAppPageFromLocation());
      setRouteRenderKey(resolveRouteRenderKey());
    };
    window.addEventListener("popstate", syncLocation);
    window.addEventListener(NAVIGATION_EVENT, syncLocation);
    return () => {
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener(NAVIGATION_EVENT, syncLocation);
    };
  }, []);

  const rememberCurrentMobileTab = useCallback(() => {
    const currentPage = pageFromPath(window.location.pathname);
    if (currentPage === "not-found") return;
    writeMobileTabSnapshot(
      clientStorageScope,
      currentPage,
      currentInternalLocation(),
      window.history.state,
      historyScrollY(window.history.state, window.scrollY),
    );
  }, [clientStorageScope]);

  useEffect(() => {
    rememberCurrentMobileTab();
    window.addEventListener("popstate", rememberCurrentMobileTab);
    window.addEventListener(NAVIGATION_EVENT, rememberCurrentMobileTab);
    window.addEventListener(HISTORY_ENTRY_UPDATED_EVENT, rememberCurrentMobileTab);
    return () => {
      window.removeEventListener("popstate", rememberCurrentMobileTab);
      window.removeEventListener(NAVIGATION_EVENT, rememberCurrentMobileTab);
      window.removeEventListener(HISTORY_ENTRY_UPDATED_EVENT, rememberCurrentMobileTab);
    };
  }, [rememberCurrentMobileTab]);

  const openPage = (id: PageID) => {
    const item = navItems.find((navItem) => navItem.id === id);
    if (!item) return;
    const path = id === "library" ? (readLastLibraryLocation(clientStorageScope) ?? item.path) : item.path;
    if (id === "library" && page === "library" && `${window.location.pathname}${window.location.search}` === path)
      return;
    openPath(path);
  };

  const openPath = (path: string, state?: unknown, restoredScrollY?: number) => {
    const nextState =
      restoredScrollY === undefined ? (state ?? {}) : requestHistoryScrollRestoration(state, restoredScrollY);
    window.history.pushState(nextState, "", path);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
    setPage(resolveAppPageFromLocation());
    setRouteRenderKey(resolveRouteRenderKey());
  };

  const openMobilePage = (id: PageID) => {
    const item = navItems.find((navItem) => navItem.id === id);
    if (!item) return;
    if (page === id && isMobileTabDetailLocation(id, currentInternalLocation())) {
      navigateToMobileTabHome(id, clientStorageScope);
      return;
    }
    rememberCurrentMobileTab();
    const snapshot = readMobileTabSnapshot(clientStorageScope, id);
    if (snapshot && pageFromSnapshotLocation(snapshot.location) === id) {
      if (page === id && currentInternalLocation() === snapshot.location) return;
      openPath(snapshot.location, mobileTabResumeHistoryState(snapshot.state), snapshot.scrollY);
      return;
    }
    openPage(id);
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const openLogin = () => setLoginOpen(true);
    window.addEventListener(LOGIN_REQUEST_EVENT, openLogin);
    return () => window.removeEventListener(LOGIN_REQUEST_EVENT, openLogin);
  }, []);

  useEffect(() => {
    if (!isNativeApp()) return;
    let disposed = false;
    CapacitorApp.addListener("backButton", async () => {
      if (disposed) return;
      if (commandPaletteOpen) {
        if (commandPaletteBusy) {
          toast.info(t("app.workflowSubmitting"));
          return;
        }
        setCommandPaletteOpen(false);
        return;
      }
      if (loginOpen) {
        setLoginOpen(false);
        return;
      }
      const closeable = document.querySelector("[data-android-back-close], [role='dialog']");
      if (closeable) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return;
      }
      const playerEvent = new CustomEvent(ANDROID_BACK_EVENT, { cancelable: true });
      window.dispatchEvent(playerEvent);
      if (playerEvent.defaultPrevented) return;
      if (window.history.length > 1 && window.location.pathname !== "/") {
        exitBackDeadlineRef.current = 0;
        window.history.back();
        return;
      }
      const now = Date.now();
      if (now < exitBackDeadlineRef.current) {
        await CapacitorApp.exitApp();
        return;
      }
      exitBackDeadlineRef.current = now + 2000;
      toast.info(t("app.pressBackAgain"));
      window.setTimeout(() => {
        if (Date.now() >= exitBackDeadlineRef.current) exitBackDeadlineRef.current = 0;
      }, 2100);
      return;
    }).catch(() => {});
    return () => {
      disposed = true;
      void CapacitorApp.removeAllListeners();
    };
  }, [commandPaletteBusy, commandPaletteOpen, loginOpen, t, toast]);

  if (auth.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        {t("app.loading")}
      </div>
    );
  }

  if (!auth.user && !auth.anonymousAccessEnabled) {
    return <LoginPage />;
  }

  return (
    <PlayerProvider key={clientStorageScope}>
      <RemoteTrackWorkflowBridge />
      <div
        className={cn(
          "app-shell min-h-screen bg-background lg:grid",
          sidebarCollapsed ? "lg:grid-cols-[76px_minmax(0,1fr)]" : "lg:grid-cols-[248px_minmax(0,1fr)]",
        )}
      >
        <aside className="theme-shell-surface sticky top-0 hidden h-screen border-r bg-card lg:flex lg:flex-col">
          <div
            className={cn(
              "flex h-[var(--header-height)] items-center border-b",
              sidebarCollapsed ? "justify-center px-3" : "px-5",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/10 ring-1 ring-primary/15">
                <img src="/kikoto-icon.svg" alt="" className="h-7 w-7 dark:invert" />
              </span>
              {!sidebarCollapsed && <div className="truncate text-xl font-bold">Kikoto</div>}
            </div>
          </div>
          <nav className={cn("app-scroll min-h-0 flex-1 overflow-y-auto", sidebarCollapsed ? "p-2" : "p-3")}>
            {visibleNavItems.map((item) => (
              <Button
                key={item.id}
                className={cn(
                  "mb-1 w-full",
                  sidebarCollapsed ? "justify-center px-0" : "justify-start",
                  page === item.id && "bg-muted",
                )}
                variant="ghost"
                size={sidebarCollapsed ? "icon" : "default"}
                title={sidebarCollapsed ? navigationLabel(item, t) : undefined}
                aria-label={sidebarCollapsed ? navigationLabel(item, t) : undefined}
                onClick={() => openPage(item.id)}
              >
                <item.icon className="h-4 w-4" />
                {!sidebarCollapsed && navigationLabel(item, t)}
              </Button>
            ))}
          </nav>
          <div className={cn("border-t", sidebarCollapsed ? "p-2" : "p-3")}>
            <Button
              variant="ghost"
              size={sidebarCollapsed ? "icon" : "default"}
              className={cn("w-full", sidebarCollapsed ? "justify-center px-0" : "justify-start")}
              aria-label={sidebarCollapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
              title={sidebarCollapsed ? t("app.expandSidebar") : undefined}
              onClick={toggleSidebar}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              {!sidebarCollapsed && t("app.collapse")}
            </Button>
          </div>
        </aside>

        <main className="app-main min-w-0">
          <header
            className="theme-shell-surface sticky top-0 z-40 border-b bg-card/95 pt-[var(--safe-area-top)] backdrop-blur lg:pt-0"
            data-toast-avoid
          >
            <div className="flex h-[var(--header-height)] min-w-0 items-center justify-between gap-2 pl-[max(0.75rem,var(--safe-area-left))] pr-[max(0.75rem,var(--safe-area-right))] lg:h-auto lg:min-h-[var(--header-height)] lg:gap-3 lg:px-6 lg:py-2">
              <div className="flex min-w-0 items-center lg:flex-row lg:items-baseline lg:gap-3">
                {!showMobilePageTitle && (
                  <img src="/kikoto-icon.svg" alt="Kikoto" className="h-8 w-8 dark:invert lg:hidden" />
                )}
                <h1
                  className={cn(
                    "truncate text-base font-semibold lg:text-2xl",
                    !showMobilePageTitle && "hidden lg:block",
                  )}
                >
                  {page === "not-found"
                    ? t("app.notFound")
                    : activeItem
                      ? navigationLabel(activeItem, t)
                      : t("nav.library")}
                </h1>
                <p className="hidden text-xs text-muted-foreground lg:line-clamp-1 lg:block lg:text-sm">
                  {page === "not-found"
                    ? t("app.notFoundDescription")
                    : activeItem
                      ? navigationDescription(activeItem, t)
                      : t("app.libraryFallback")}
                </p>
              </div>
              <HeaderActions
                user={auth.user}
                hasPermission={effectiveHasPermission}
                onLogout={() => void auth.logout()}
                onOpenLogin={() => setLoginOpen(true)}
                onOpenPage={openPage}
                onOpenPath={openPath}
                onOpenCommandPalette={() => setCommandPaletteOpen(true)}
                onLocaleChange={updateLocale}
              />
            </div>
          </header>
          <MobileConnectionBanner
            kind={mobileRuntime.connection.kind}
            message={mobileRuntime.connection.message}
            releaseUrl={mobileRuntime.connection.releaseUrl}
            noticeKey={mobileRuntime.connection.noticeKey}
            onReconnect={() => void mobileRuntime.reconnect()}
          />

          <RouteErrorBoundary
            resetKey={routeRenderKey}
            onOpenLibrary={() => openPath("/")}
            title={t("notFound.pageUnavailable")}
            message={t("notFound.routeErrorMessage")}
            retryLabel={t("notFound.retryPage")}
            libraryLabel={t("notFound.openLibrary")}
          >
            <Suspense fallback={<PageLoading />}>
              <div className="py-[var(--page-padding-y)] pl-[max(1rem,var(--safe-area-left))] pr-[max(1rem,var(--safe-area-right))] lg:px-6">
                {page !== "not-found" && !canAccessCurrentPage && (
                  <AccessRequiredPage page={page} onOpenLogin={() => setLoginOpen(true)} />
                )}
                {page === "not-found" && (
                  <NotFoundPage
                    onBack={() => (window.history.length > 1 ? window.history.back() : openPath("/"))}
                    onOpenLibrary={() => openPath("/")}
                  />
                )}
                <CachedBrowsePages key={clientStorageScope} activePage={canAccessCurrentPage ? page : null} />
                {canAccessCurrentPage && page === "settings" && auth.user && (
                  <SettingsPage user={auth.user} readOnly={auth.demoMode} onAccountUpdated={auth.refresh} />
                )}
                {canAccessCurrentPage && page === "maintenance" && auth.user && (
                  <MaintenancePage
                    canManageSources={auth.demoMode || auth.hasPermission("sources:write")}
                    canManageUsers={auth.demoMode || auth.hasPermission("users:manage")}
                    currentUserId={auth.user.id}
                    isSuperAdmin={auth.user.role === "super_admin"}
                    canManageAccessPolicy={auth.user.role === "super_admin" && auth.runtimeMode !== "demo"}
                    readOnly={auth.demoMode}
                    onAccessPolicyUpdated={auth.refreshRuntime}
                  />
                )}
                {canAccessCurrentPage && (page === "workflows" || page === "activity") && (
                  <WorkflowsPage
                    surface={page}
                    canRun={auth.demoMode || auth.hasPermission("workflows:run")}
                    canSyncMetadata={auth.demoMode || auth.hasPermission("metadata:sync")}
                    canTagWorks={auth.demoMode || auth.hasPermission("tags:write")}
                    canManageDownloads={auth.demoMode || auth.hasPermission("downloads:manage")}
                    readOnly={auth.demoMode}
                  />
                )}
                {canAccessCurrentPage && page === "about" && <AboutPage />}
                {![
                  "library",
                  "favorites",
                  "circles",
                  "voice-actors",
                  "settings",
                  "maintenance",
                  "workflows",
                  "activity",
                  "about",
                ].includes(page) && (
                  <PlaceholderPage title={activeItem ? navigationLabel(activeItem, t) : t("app.pageReserved")} />
                )}
              </div>
            </Suspense>
          </RouteErrorBoundary>
        </main>

        {!mobileRuntime.keyboardOpen && (
          <footer className="theme-shell-surface fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[var(--safe-area-bottom)] pl-[var(--safe-area-left)] pr-[var(--safe-area-right)] backdrop-blur lg:hidden">
            <nav className="grid grid-cols-4">
              {mobileNavItems.map((item) => {
                return (
                  <button
                    key={item.id}
                    className={cn(
                      "flex h-[var(--mobile-navigation-height)] flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground",
                      page === item.id && "bg-muted text-foreground",
                    )}
                    onClick={() => openMobilePage(item.id)}
                  >
                    <item.icon className="h-4 w-4" />
                    <span>{navigationLabel(item, t)}</span>
                  </button>
                );
              })}
            </nav>
          </footer>
        )}
        {!mobileRuntime.keyboardOpen && <PlayerDock />}
        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          hasPermission={effectiveHasPermission}
          visibleNavItems={visibleNavItems}
          currentUserId={auth.user?.id ?? null}
          onBusyChange={setCommandPaletteBusy}
          onOpenPage={openPage}
          onOpenPath={openPath}
        />
        {loginOpen && <LoginOverlay onClose={() => setLoginOpen(false)} />}
      </div>
    </PlayerProvider>
  );
}

const cachedBrowsePages = ["library", "favorites", "circles", "voice-actors"] as const;
type CachedBrowsePage = (typeof cachedBrowsePages)[number];

function CachedBrowsePages({ activePage }: { activePage: AppPage | null }) {
  const [visitedPages, setVisitedPages] = useState<ReadonlySet<CachedBrowsePage>>(() => {
    return activePage && isCachedBrowsePage(activePage) ? new Set([activePage]) : new Set();
  });
  const pageToMount = activePage && isCachedBrowsePage(activePage) ? activePage : null;
  const mountedPages = new Set(visitedPages);
  if (pageToMount) mountedPages.add(pageToMount);

  useEffect(() => {
    if (!pageToMount) return;
    setVisitedPages((current) => (current.has(pageToMount) ? current : new Set([...current, pageToMount])));
  }, [pageToMount]);

  return (
    <>
      {mountedPages.has("library") && (
        <div hidden={activePage !== "library"}>
          <LibraryPage active={activePage === "library"} />
        </div>
      )}
      {mountedPages.has("favorites") && (
        <div hidden={activePage !== "favorites"}>
          <FavoritesPage active={activePage === "favorites"} />
        </div>
      )}
      {mountedPages.has("circles") && (
        <div hidden={activePage !== "circles"}>
          <CirclesPage active={activePage === "circles"} />
        </div>
      )}
      {mountedPages.has("voice-actors") && (
        <div hidden={activePage !== "voice-actors"}>
          <CreatorWorksPage kind="voice" active={activePage === "voice-actors"} />
        </div>
      )}
    </>
  );
}

function isCachedBrowsePage(page: AppPage): page is CachedBrowsePage {
  return cachedBrowsePages.includes(page as CachedBrowsePage);
}

function RemoteTrackWorkflowBridge() {
  const [runs, setRuns] = useState<Record<number, RemoteTrackCreatedDetail>>({});

  useEffect(() => {
    const addRun = (event: Event) => {
      const detail = (event as CustomEvent<RemoteTrackCreatedDetail>).detail;
      if (!detail?.runId) return;
      setRuns((current) => ({ ...current, [detail.runId]: detail }));
    };
    window.addEventListener(REMOTE_TRACK_CREATED_EVENT, addRun);
    return () => window.removeEventListener(REMOTE_TRACK_CREATED_EVENT, addRun);
  }, []);

  const removeRun = useCallback((runId: number) => {
    setRuns((current) => {
      if (!(runId in current)) return current;
      const next = { ...current };
      delete next[runId];
      return next;
    });
  }, []);

  return Object.values(runs).map((detail) => (
    <RemoteTrackWorkflowObserver key={detail.runId} detail={detail} onDone={removeRun} />
  ));
}

function RemoteTrackWorkflowObserver({
  detail,
  onDone,
}: {
  detail: RemoteTrackCreatedDetail;
  onDone: (runId: number) => void;
}) {
  const toast = useToast();
  const auth = useAuth();
  const { t } = useTranslation();
  const [run, setRun] = useState<RemoteTrackRunStatus | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = await api.getRemoteTrackRunStatus(detail.runId);
        if (disposed) return;
        setRun(next);
        if (next.status === "queued" || next.status === "running") {
          timer = window.setTimeout(() => void poll(), document.hidden ? 10_000 : 1_500);
        }
      } catch {
        if (!disposed) timer = window.setTimeout(() => void poll(), 5_000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [detail.runId]);

  useEffect(() => {
    if (!run || handled.current || run.status === "queued" || run.status === "running") return;
    handled.current = true;
    const summary = parseRemoteTrackSummary(run.summaryJson);
    const succeeded = run.status === "succeeded" || run.status === "partial";
    const primaryCode = summary.primaryCode || detail.primaryCode || detail.requestedCode;
    const terminal: RemoteTrackTerminalDetail = {
      ...detail,
      status: run.status,
      primaryCode,
      workId: summary.workId,
      fileSourceId: summary.fileSourceId || detail.sourceId,
    };
    const canOpenActivity = !auth.demoMode && auth.hasPermission("workflows:run");
    toast.notify({
      kind: succeeded ? "success" : "error",
      message: succeeded
        ? t("workflows.trackCompleted", { id: run.runId, primaryCode })
        : t("workflows.trackFailed", { id: run.runId, primaryCode }),
      actionLabel: canOpenActivity ? t("nav.activity") : undefined,
      onAction: canOpenActivity ? () => openWorkflowActivity(run.runId) : undefined,
    });
    window.dispatchEvent(new CustomEvent<RemoteTrackTerminalDetail>(REMOTE_TRACK_TERMINAL_EVENT, { detail: terminal }));
    onDone(detail.runId);
  }, [auth.demoMode, auth.hasPermission, detail, onDone, run, t, toast]);

  return null;
}

function parseRemoteTrackSummary(raw: string) {
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch {
    value = {};
  }
  const workId = Number(value.work_id);
  const fileSourceId = Number(value.source_id);
  return {
    workId: Number.isInteger(workId) && workId > 0 ? workId : null,
    fileSourceId: Number.isInteger(fileSourceId) && fileSourceId > 0 ? fileSourceId : 0,
    primaryCode: typeof value.primary_code === "string" ? value.primary_code.trim().toUpperCase() : "",
  };
}

function openWorkflowActivity(runId: number) {
  window.history.pushState({}, "", `/activity?run=${runId}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function MobileConnectionBanner({
  kind,
  message,
  releaseUrl,
  noticeKey,
  onReconnect,
}: {
  kind: string;
  message: string;
  releaseUrl: string;
  noticeKey: string;
  onReconnect: () => void;
}) {
  const { t } = useTranslation();
  const dismissedStorageKey = "kikoto:dismissed-version-notice";
  const [dismissedNotice, setDismissedNotice] = useState(() => localStorage.getItem(dismissedStorageKey) ?? "");
  const isClientUpdate = kind === "client-update-available" || kind === "client-update-required";
  const isServerUpdate = kind === "server-update-available";
  const isRequired = kind === "client-update-required";
  const isDismissed = !isRequired && noticeKey && dismissedNotice === noticeKey;
  if (!isNativeApp() || !message || ["online", "idle", "checking", "reconnecting"].includes(kind)) return null;
  if (isDismissed) return null;
  const Icon = isRequired ? AlertTriangle : isClientUpdate ? Download : isServerUpdate ? Server : WifiOff;
  return (
    <div className="border-b bg-muted/70 px-4 py-2 text-sm lg:px-6" data-toast-avoid>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">{message}</span>
        {(isClientUpdate || isServerUpdate) && releaseUrl ? (
          <Button variant="outline" size="sm" asChild>
            <a href={releaseUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              {isClientUpdate ? t("app.viewUpdate") : t("app.viewRelease")}
            </a>
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onReconnect}>
            {t("account.reconnect")}
          </Button>
        )}
        {!isRequired && noticeKey && (
          <button
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              localStorage.setItem(dismissedStorageKey, noticeKey);
              setDismissedNotice(noticeKey);
            }}
            aria-label={t("app.dismissVersionNotice")}
            title={t("app.remindNextVersion")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function LoginOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={onClose}
    >
      <div onMouseDown={(event) => event.stopPropagation()}>
        <LoginPage embedded onSuccess={onClose} />
      </div>
    </div>
  );
}

function PageLoading() {
  const { t } = useTranslation();
  return (
    <div className="space-y-5 px-4 py-5 lg:px-6" aria-label={t("app.loadingPage")}>
      <section className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-7 w-48 animate-pulse rounded bg-muted" />
            <div className="h-4 w-72 max-w-full animate-pulse rounded bg-muted" />
          </div>
          <div className="grid grid-cols-3 gap-2 sm:flex">
            <div className="h-14 w-24 animate-pulse rounded-md border bg-muted" />
            <div className="h-14 w-24 animate-pulse rounded-md border bg-muted" />
            <div className="h-14 w-24 animate-pulse rounded-md border bg-muted" />
          </div>
        </div>
      </section>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="h-10 w-10 animate-pulse rounded-md bg-muted" />
              <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
            </div>
            <div className="mt-5 space-y-2">
              <div className="h-5 w-36 animate-pulse rounded bg-muted" />
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function pageFromPath(rawPath: string): AppPage {
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  if (path === "/" || isWorkCodePath(path)) {
    return "library";
  }
  if (path === "/runs") {
    return "activity";
  }
  if (path === "/users") {
    return "maintenance";
  }
  const item = navItems.find((navItem) => navItem.path === path);
  if (item) {
    return item.id;
  }
  if (/^\/[^/]+$/.test(path)) {
    return "library";
  }
  if (/^\/circles\/[^/]+(?:\/series(?:\/[^/]+)?)?$/.test(path)) {
    return "circles";
  }
  if (path === "/voices" || /^\/voices\/\d+$/.test(path)) {
    return "voice-actors";
  }
  if (
    path === "/tracked" ||
    path === "/no-source" ||
    ["/library", "/library/tracked", "/library/no-source", "/library/all", "/library/remote"].includes(path) ||
    /^\/library\/source\/[^/]+$/.test(path)
  ) {
    return "library";
  }
  return "not-found";
}

function isMobileTabDetailLocation(id: PageID, location: string) {
  try {
    const parsed = new URL(location, "https://kikoto.invalid");
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
    const listLocation = `${pathname}${parsed.search}`;
    if (id === "library") {
      return pageFromPath(pathname) === "library" && normalizeLibraryBrowseLocation(listLocation) === null;
    }
    if (id === "circles") return /^\/circles\/[^/]+(?:\/series(?:\/[^/]+)?)?$/i.test(pathname);
    if (id === "voice-actors") return /^\/voices\/\d+$/i.test(pathname);
  } catch {
    return false;
  }
  return false;
}

function navigateToMobileTabHome(id: PageID, storageScope: string) {
  if (id === "library") {
    navigateToWorkspaceUp({
      mobile: true,
      fallbackLocation: readLastLibraryLocation(storageScope) ?? "/",
      isWorkspaceListLocation: (location) => normalizeLibraryBrowseLocation(location) !== null,
    });
    return;
  }
  if (id === "circles") {
    navigateToWorkspaceUp({
      mobile: true,
      fallbackLocation: readLastCircleListLocation(storageScope) ?? "/circles",
      isWorkspaceListLocation: isCircleListLocation,
    });
    return;
  }
  if (id === "voice-actors") {
    navigateToWorkspaceUp({
      mobile: true,
      fallbackLocation: readLastVoiceListLocation(storageScope) ?? "/voices",
      isWorkspaceListLocation: isVoiceListLocation,
    });
  }
}

function pageFromSnapshotLocation(location: string): AppPage {
  try {
    return pageFromPath(new URL(location, window.location.origin).pathname);
  } catch {
    return "not-found";
  }
}

function resolveAppPageFromLocation() {
  const redirect = legacyLibraryRedirect(window.location.pathname, window.location.search);
  if (redirect) {
    window.history.replaceState(window.history.state ?? {}, "", redirect);
  }
  return pageFromPath(window.location.pathname);
}

function resolveRouteRenderKey() {
  return `${window.location.pathname}${window.location.search}`;
}

function PlaceholderPage({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t("app.pageReserved")}</p>
    </section>
  );
}

function AccessRequiredPage({ page, onOpenLogin }: { page: PageID; onOpenLogin: () => void }) {
  const { t } = useTranslation();
  const item = navItems.find((navItem) => navItem.id === page);
  const title = item ? navigationLabel(item, t) : t("app.thisPage");
  const needsLogin = item?.audience === "authenticated";
  return (
    <section className="rounded-lg border bg-card p-6">
      <div className="mb-3 grid h-10 w-10 place-items-center rounded-md bg-secondary text-secondary-foreground">
        <Lock className="h-5 w-5" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {needsLogin ? t("auth.signInToAccess") : t("auth.permissionRequired")}
      </p>
      {needsLogin && (
        <Button className="mt-4" onClick={onOpenLogin}>
          {t("account.signIn")}
        </Button>
      )}
    </section>
  );
}
