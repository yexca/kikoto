import { App as CapacitorApp } from "@capacitor/app";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Lock, PanelLeftClose, PanelLeftOpen, WifiOff } from "lucide-react";

import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { canAccessPage, navItems, visibleNavigationItems, type PageID } from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { LOGIN_REQUEST_EVENT } from "@/components/ui/toast";
import { LoginPage } from "@/pages/LoginPage";
import { cn } from "@/lib/utils";
import { PlayerDock, PlayerProvider } from "@/player/PlayerProvider";
import { HeaderActions } from "@/app/HeaderActions";
import { CommandPalette } from "@/app/CommandPalette";
import { useScrollRestoration } from "@/app/scrollRestoration";
import { MobileRuntimeProvider, useMobileRuntime } from "@/app/MobileRuntime";
import { ANDROID_BACK_EVENT } from "@/app/events";
import { isNativeApp } from "@/lib/serverConfig";

const LibraryPage = lazy(() => import("@/pages/LibraryPage").then((module) => ({ default: module.LibraryPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const WorkflowsPage = lazy(() => import("@/pages/WorkflowsPage").then((module) => ({ default: module.WorkflowsPage })));
const UsersPage = lazy(() => import("@/pages/UsersPage").then((module) => ({ default: module.UsersPage })));
const FavoritesPage = lazy(() => import("@/pages/FavoritesPage").then((module) => ({ default: module.FavoritesPage })));
const CreatorWorksPage = lazy(() => import("@/pages/CreatorWorksPage").then((module) => ({ default: module.CreatorWorksPage })));
const CirclesPage = lazy(() => import("@/pages/CirclesPage").then((module) => ({ default: module.CirclesPage })));
const AboutPage = lazy(() => import("@/pages/AboutPage").then((module) => ({ default: module.AboutPage })));

const preferredMobileTabs: PageID[] = ["library", "favorites", "circles", "voice-actors"];
const WORK_CODE_PATH_PATTERN = /^\/(?:RJ|BJ|VJ|CC)\d{4,8}\/?$/i;
const SIDEBAR_COLLAPSED_KEY = "kikoto:sidebar-collapsed";

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
  const [page, setPage] = useState<PageID>(() => pageFromPath(window.location.pathname));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const mobileRuntime = useMobileRuntime();
  const authState = auth.user ? "authenticated" : "anonymous";
  const visibleNavItems = useMemo(
    () => visibleNavigationItems({ state: authState, hasPermission: auth.hasPermission }),
    [auth.hasPermission, authState],
  );
  const mobileNavItems = useMemo(() => {
    const preferred = preferredMobileTabs
      .map((id) => visibleNavItems.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (preferred.length >= 4) return preferred.slice(0, 4);
    const additions = visibleNavItems.filter((item) => !preferred.some((candidate) => candidate.id === item.id));
    return [...preferred, ...additions].slice(0, 4);
  }, [visibleNavItems]);
  const activeItem = useMemo(() => visibleNavItems.find((item) => item.id === page), [page, visibleNavItems]);
  const canAccessCurrentPage = canAccessPage(page, authState, auth.hasPermission);

  useEffect(() => {
    const handlePopState = () => setPage(pageFromPath(window.location.pathname));
    const handleAppNavigation = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("kikoto:navigation", handleAppNavigation);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("kikoto:navigation", handleAppNavigation);
    };
  }, []);

  const openPage = (id: PageID) => {
    const item = navItems.find((navItem) => navItem.id === id);
    if (!item) return;
    openPath(item.path);
  };

  const openPath = (path: string, state?: unknown) => {
    window.history.pushState(state ?? {}, "", path);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setPage(pageFromPath(new URL(path, window.location.origin).pathname));
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
        window.history.back();
        return;
      }
      await CapacitorApp.exitApp();
    }).catch(() => {});
    return () => {
      disposed = true;
      void CapacitorApp.removeAllListeners();
    };
  }, [commandPaletteOpen, loginOpen]);

  if (auth.isLoading) {
    return <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">Loading Kikoto...</div>;
  }

  return (
    <PlayerProvider>
      <div
        className={cn(
          "app-shell min-h-screen bg-background lg:grid",
          sidebarCollapsed ? "lg:grid-cols-[76px_minmax(0,1fr)]" : "lg:grid-cols-[248px_minmax(0,1fr)]",
        )}
      >
        <aside className="sticky top-0 hidden h-screen border-r bg-card lg:flex lg:flex-col">
          <div className={cn("flex h-16 items-center border-b", sidebarCollapsed ? "justify-center px-3" : "px-5")}>
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/10 ring-1 ring-primary/15">
                <img src="/kikoto-icon.svg" alt="" className="h-7 w-7" />
              </span>
              {!sidebarCollapsed && <div className="truncate text-xl font-bold">Kikoto</div>}
            </div>
          </div>
          <nav className={cn("min-h-0 flex-1 overflow-y-auto", sidebarCollapsed ? "p-2" : "p-3")}>
            {visibleNavItems.map((item) => (
              <Button
                key={item.id}
                className={cn("mb-1 w-full", sidebarCollapsed ? "justify-center px-0" : "justify-start", page === item.id && "bg-muted")}
                variant="ghost"
                size={sidebarCollapsed ? "icon" : "default"}
                title={sidebarCollapsed ? item.label : undefined}
                aria-label={sidebarCollapsed ? item.label : undefined}
                onClick={() => openPage(item.id)}
              >
                <item.icon className="h-4 w-4" />
                {!sidebarCollapsed && item.label}
              </Button>
            ))}
          </nav>
          <div className={cn("border-t", sidebarCollapsed ? "p-2" : "p-3")}>
            <Button
              variant="ghost"
              size={sidebarCollapsed ? "icon" : "default"}
              className={cn("w-full", sidebarCollapsed ? "justify-center px-0" : "justify-start")}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : undefined}
              onClick={toggleSidebar}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              {!sidebarCollapsed && "Collapse"}
            </Button>
          </div>
        </aside>

        <main className="min-w-0">
          <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur" data-toast-avoid>
            <div className="flex min-h-16 items-center justify-between gap-3 px-4 lg:px-6">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Personal audio library</p>
                <h1 className="truncate text-xl font-semibold lg:text-2xl">{activeItem?.label ?? "Library"}</h1>
              </div>
              <HeaderActions
                user={auth.user}
                hasPermission={auth.hasPermission}
                onLogout={() => void auth.logout()}
                onOpenLogin={() => setLoginOpen(true)}
                onOpenPage={openPage}
                onOpenPath={openPath}
                onOpenCommandPalette={() => setCommandPaletteOpen(true)}
              />
            </div>
          </header>
          <MobileConnectionBanner
            kind={mobileRuntime.connection.kind}
            message={mobileRuntime.connection.message}
            onReconnect={() => void mobileRuntime.reconnect()}
          />

          <Suspense fallback={<PageLoading />}>
            <div className="px-4 py-5 lg:px-6">
              {!canAccessCurrentPage && <AccessRequiredPage page={page} onOpenLogin={() => setLoginOpen(true)} />}
              {canAccessCurrentPage && page === "library" && <LibraryPage />}
              {canAccessCurrentPage && page === "favorites" && <FavoritesPage />}
              {canAccessCurrentPage && page === "circles" && <CirclesPage />}
              {canAccessCurrentPage && page === "voice-actors" && <CreatorWorksPage kind="voice" />}
              {canAccessCurrentPage && page === "settings" && <SettingsPage canManageSources={auth.hasPermission("sources:write")} />}
              {canAccessCurrentPage && page === "workflows" && <WorkflowsPage surface="workflows" canRun={auth.hasPermission("workflows:run")} canSyncMetadata={auth.hasPermission("metadata:sync")} />}
              {canAccessCurrentPage && page === "activity" && <WorkflowsPage surface="activity" canRun={auth.hasPermission("workflows:run")} canSyncMetadata={auth.hasPermission("metadata:sync")} />}
              {canAccessCurrentPage && page === "users" && auth.user && <UsersPage currentUserId={auth.user.id} isSuperAdmin={auth.user.role === "super_admin"} />}
              {canAccessCurrentPage && page === "about" && <AboutPage />}
              {!["library", "favorites", "circles", "voice-actors", "settings", "workflows", "activity", "users", "about"].includes(page) && (
                <PlaceholderPage title={activeItem?.label ?? "Page"} />
              )}
            </div>
          </Suspense>
        </main>

        <footer className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          <nav className="grid grid-cols-4">
            {mobileNavItems.map((item) => {
              return (
                <button
                  key={item.id}
                  className={cn(
                    "flex h-16 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground",
                    page === item.id && "bg-muted text-foreground",
                  )}
                  onClick={() => openPage(item.id)}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </footer>
        <PlayerDock />
        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          hasPermission={auth.hasPermission}
          visibleNavItems={visibleNavItems}
          onOpenPage={openPage}
          onOpenPath={openPath}
        />
        {loginOpen && <LoginOverlay onClose={() => setLoginOpen(false)} />}
      </div>
    </PlayerProvider>
  );
}

function MobileConnectionBanner({
  kind,
  message,
  onReconnect,
}: {
  kind: string;
  message: string;
  onReconnect: () => void;
}) {
  if (!isNativeApp() || !message || kind === "online" || kind === "idle") return null;
  const Icon = kind === "version-warning" ? AlertTriangle : WifiOff;
  return (
    <div className="border-b bg-muted/70 px-4 py-2 text-sm lg:px-6" data-toast-avoid>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">{message}</span>
        <Button variant="outline" size="sm" onClick={onReconnect}>
          Reconnect
        </Button>
      </div>
    </div>
  );
}

function LoginOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div onMouseDown={(event) => event.stopPropagation()}>
        <LoginPage embedded onSuccess={onClose} />
      </div>
    </div>
  );
}

function PageLoading() {
  return (
    <div className="space-y-5 px-4 py-5 lg:px-6" aria-label="Loading page">
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

function pageFromPath(path: string): PageID {
  if (path === "/" || WORK_CODE_PATH_PATTERN.test(path)) {
    return "library";
  }
  if (path === "/runs") {
    return "activity";
  }
  const item = navItems.find((navItem) => navItem.path === path);
  if (item) {
    return item.id;
  }
  if (path.startsWith("/circles/")) {
    return "circles";
  }
  if (path === "/voices" || path.startsWith("/voices/")) {
    return "voice-actors";
  }
  if (path === "/tracked" || path === "/no-source" || path === "/library" || path.startsWith("/library/")) {
    return "library";
  }
  return "library";
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">This surface is reserved for the next product slice.</p>
    </section>
  );
}

function AccessRequiredPage({ page, onOpenLogin }: { page: PageID; onOpenLogin: () => void }) {
  const item = navItems.find((navItem) => navItem.id === page);
  const title = item?.label ?? "This page";
  const needsLogin = item?.audience === "authenticated";
  return (
    <section className="rounded-lg border bg-card p-6">
      <div className="mb-3 grid h-10 w-10 place-items-center rounded-md bg-secondary text-secondary-foreground">
        <Lock className="h-5 w-5" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {needsLogin ? "Sign in to access this page." : "Your account does not have permission to access this page."}
      </p>
      {needsLogin && (
        <Button className="mt-4" onClick={onOpenLogin}>
          Sign in
        </Button>
      )}
    </section>
  );
}
