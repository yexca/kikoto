import { useEffect, useMemo, useState } from "react";
import { Bell, LogOut, Moon, Search, Shield } from "lucide-react";

import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { navItems, type PageID } from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LibraryPage } from "@/pages/LibraryPage";
import { NowPlayingPage } from "@/pages/NowPlayingPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WorkflowsPage } from "@/pages/WorkflowsPage";
import { LoginPage } from "@/pages/LoginPage";
import { UsersPage } from "@/pages/UsersPage";
import { cn } from "@/lib/utils";
import { PlayerDock, PlayerProvider } from "@/player/PlayerProvider";

const mobileTabs: PageID[] = ["library", "favorites", "now-playing", "settings"];
const WORK_CODE_PATH_PATTERN = /^\/(?:RJ|BJ|VJ|CC)\d{4,8}\/?$/i;

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
    window.history.pushState({}, "", item.path);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setPage(id);
  };

  if (auth.isLoading) {
    return <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">Loading Kikoto...</div>;
  }

  if (!auth.user) {
    return <LoginPage />;
  }

  return (
    <PlayerProvider>
      <div className="min-h-screen bg-background pb-20 lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:pb-0">
        <aside className="hidden border-r bg-card lg:block">
          <div className="flex h-16 items-center border-b px-5">
            <div className="text-xl font-bold">Kikoto</div>
          </div>
          <nav className="p-3">
            {visibleNavItems.map((item) => (
              <Button
                key={item.id}
                className={cn("mb-1 w-full justify-start", page === item.id && "bg-muted")}
                variant="ghost"
                onClick={() => openPage(item.id)}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur">
            <div className="flex min-h-16 items-center justify-between gap-3 px-4 lg:px-6">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Personal audio library</p>
                <h1 className="truncate text-xl font-semibold lg:text-2xl">{activeItem?.label ?? "Library"}</h1>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="hidden items-center gap-1 sm:inline-flex">
                  <Shield className="h-3 w-3" />
                  {auth.user.role}
                  {auth.user.devMode ? " dev" : ""}
                </Badge>
                <Button variant="outline" size="icon" aria-label="Search">
                  <Search className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="Job activity">
                  <Bell className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="Theme">
                  <Moon className="h-4 w-4" />
                </Button>
                {!auth.user.devMode && (
                  <Button variant="outline" size="icon" aria-label="Sign out" onClick={() => void auth.logout()}>
                    <LogOut className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </header>

          <div className="px-4 py-5 lg:px-6">
            {page === "library" && <LibraryPage />}
            {page === "now-playing" && <NowPlayingPage />}
            {page === "settings" && <SettingsPage canManageSources={auth.hasPermission("sources:write")} />}
            {page === "workflows" && <WorkflowsPage surface="workflows" canRun={auth.hasPermission("workflows:run")} canSyncMetadata={auth.hasPermission("metadata:sync")} />}
            {page === "activity" && <WorkflowsPage surface="activity" canRun={auth.hasPermission("workflows:run")} canSyncMetadata={auth.hasPermission("metadata:sync")} />}
            {page === "users" && <UsersPage currentUserId={auth.user.id} isSuperAdmin={auth.user.role === "super_admin"} />}
            {!["library", "now-playing", "settings", "workflows", "activity", "users"].includes(page) && (
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
  if (path === "/remote" || path === "/library" || path.startsWith("/library/")) {
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
