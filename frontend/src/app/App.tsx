import { useMemo, useState } from "react";
import { Bell, Moon, Search } from "lucide-react";

import { navItems, type PageID } from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LibraryPage } from "@/pages/LibraryPage";
import { NowPlayingPage } from "@/pages/NowPlayingPage";
import { SourcesPage } from "@/pages/SourcesPage";
import { WorkflowsPage } from "@/pages/WorkflowsPage";
import { cn } from "@/lib/utils";
import { PlayerDock, PlayerProvider } from "@/player/PlayerProvider";

const mobileTabs: PageID[] = ["library", "favorites", "now-playing", "settings"];

export function App() {
  const [page, setPage] = useState<PageID>("library");
  const activeItem = useMemo(() => navItems.find((item) => item.id === page), [page]);

  return (
    <PlayerProvider>
      <div className="min-h-screen bg-background pb-20 lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:pb-0">
        <aside className="hidden border-r bg-card lg:block">
          <div className="flex h-16 items-center border-b px-5">
            <div className="text-xl font-bold">Kikoto</div>
          </div>
          <nav className="p-3">
            {navItems.map((item) => (
              <Button
                key={item.id}
                className={cn("mb-1 w-full justify-start", page === item.id && "bg-muted")}
                variant="ghost"
                onClick={() => setPage(item.id)}
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
                <Button variant="outline" size="icon" aria-label="Search">
                  <Search className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="Job activity">
                  <Bell className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" aria-label="Theme">
                  <Moon className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </header>

          <div className="px-4 py-5 lg:px-6">
            {page === "library" && <LibraryPage />}
            {page === "now-playing" && <NowPlayingPage />}
            {page === "sources" && <SourcesPage />}
            {page === "workflows" && <WorkflowsPage />}
            {!["library", "now-playing", "sources", "workflows"].includes(page) && (
              <PlaceholderPage title={activeItem?.label ?? "Page"} />
            )}
          </div>
        </main>

        <footer className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 backdrop-blur lg:hidden">
          <nav className="grid grid-cols-4">
            {mobileTabs.map((id) => {
              const item = navItems.find((navItem) => navItem.id === id)!;
              return (
                <button
                  key={id}
                  className={cn(
                    "flex h-16 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground",
                    page === id && "bg-muted text-foreground",
                  )}
                  onClick={() => setPage(id)}
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

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">This surface is reserved for the next product slice.</p>
    </section>
  );
}
