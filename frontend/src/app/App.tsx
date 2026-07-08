import { useEffect, useMemo, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { navItems, type PageID } from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { LibraryPage } from "@/pages/LibraryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WorkflowsPage } from "@/pages/WorkflowsPage";
import { LoginPage } from "@/pages/LoginPage";
import { UsersPage } from "@/pages/UsersPage";
import { FavoritesPage } from "@/pages/FavoritesPage";
import { CreatorWorksPage } from "@/pages/CreatorWorksPage";
import { CirclesPage } from "@/pages/CirclesPage";
import { cn } from "@/lib/utils";
import { PlayerDock, PlayerProvider } from "@/player/PlayerProvider";
import { HeaderActions } from "@/app/HeaderActions";
import { CommandPalette } from "@/app/CommandPalette";

const mobileTabs: PageID[] = ["library", "favorites", "circles", "settings"];
const WORK_CODE_PATH_PATTERN = /^\/(?:RJ|BJ|VJ|CC)\d{4,8}\/?$/i;
const SIDEBAR_COLLAPSED_KEY = "kikoto:sidebar-collapsed";

export function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}

function AuthenticatedApp() {
  const auth = useAuth();
  const [page, setPage] = useState<PageID>(() => pageFromPath(window.location.pathname));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const visibleNavItems = useMemo(
    () => navItems.filter((item) => !item.permission || auth.hasPermission(item.permission)),
    [auth],
  );
  const activeItem = useMemo(() => visibleNavItems.find((item) => item.id === page), [page, visibleNavItems]);

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

  if (auth.isLoading) {
    return <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">Loading Kikoto...</div>;
  }

  if (!auth.user) {
    return <LoginPage />;
  }

  return (
    <PlayerProvider>
      <div
        className={cn(
          "min-h-screen bg-background pb-20 lg:grid lg:pb-0",
          sidebarCollapsed ? "lg:grid-cols-[76px_minmax(0,1fr)]" : "lg:grid-cols-[248px_minmax(0,1fr)]",
        )}
      >
        <aside className="sticky top-0 hidden h-screen border-r bg-card lg:flex lg:flex-col">
          <div className={cn("flex h-16 items-center border-b", sidebarCollapsed ? "justify-center px-3" : "px-5")}>
            <div className="flex min-w-0 items-center gap-2">
              <img src="/kikoto-icon.svg" alt="" className="h-8 w-8 shrink-0" />
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
          <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur">
            <div className="flex min-h-16 items-center justify-between gap-3 px-4 lg:px-6">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Personal audio library</p>
                <h1 className="truncate text-xl font-semibold lg:text-2xl">{activeItem?.label ?? "Library"}</h1>
              </div>
              <HeaderActions
                user={auth.user}
                hasPermission={auth.hasPermission}
                onLogout={() => void auth.logout()}
                onOpenPage={openPage}
                onOpenPath={openPath}
                onOpenCommandPalette={() => setCommandPaletteOpen(true)}
              />
            </div>
          </header>

          <div className="px-4 py-5 lg:px-6">
            {page === "library" && <LibraryPage />}
            {page === "favorites" && <FavoritesPage />}
            {page === "circles" && <CirclesPage />}
            {page === "voice-actors" && <CreatorWorksPage kind="voice" />}
            {page === "settings" && <SettingsPage canManageSources={auth.hasPermission("sources:write")} />}
            {page === "workflows" && <WorkflowsPage surface="workflows" canRun={auth.hasPermission("workflows:run")} canSyncMetadata={auth.hasPermission("metadata:sync")} />}
            {page === "activity" && <WorkflowsPage surface="activity" canRun={auth.hasPermission("workflows:run")} canSyncMetadata={auth.hasPermission("metadata:sync")} />}
            {page === "users" && <UsersPage currentUserId={auth.user.id} isSuperAdmin={auth.user.role === "super_admin"} />}
            {!["library", "favorites", "circles", "voice-actors", "settings", "workflows", "activity", "users"].includes(page) && (
              <PlaceholderPage title={activeItem?.label ?? "Page"} />
            )}
          </div>
        </main>

        <footer className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 backdrop-blur lg:hidden">
          <nav className="grid grid-cols-4">
            {mobileTabs.map((id) => {
              const item = visibleNavItems.find((navItem) => navItem.id === id);
              if (!item) return null;
              return (
                <button
                  key={id}
                  className={cn(
                    "flex h-16 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground",
                    page === id && "bg-muted text-foreground",
                  )}
                  onClick={() => openPage(id)}
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
          onOpenPage={openPage}
          onOpenPath={openPath}
        />
      </div>
    </PlayerProvider>
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
