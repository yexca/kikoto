import { BookOpen, Boxes, ExternalLink, FolderCode, Scale, Sparkles } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { APP_CLIENT_VERSION, KIKOTO_RELEASES_URL } from "@/lib/appInfo";

const dependencyGroups = [
  {
    title: "Frontend",
    items: ["React", "TypeScript", "Vite", "Tailwind CSS", "@xyflow/react", "lucide-react", "Radix Slot"],
  },
  {
    title: "Backend",
    items: ["Go", "SQLite", "modernc.org/sqlite", "golang.org/x/crypto"],
  },
  {
    title: "Mobile",
    items: ["Capacitor", "Android WebView", "AndroidX", "Gradle"],
  },
  {
    title: "Runtime & Release",
    items: ["Docker", "Docker Compose", "GitHub Actions"],
  },
] as const;

export function AboutPage() {
  return (
    <div className="space-y-5">
      <section className="rounded-lg border bg-card p-5">
        <p className="text-xs font-medium text-muted-foreground">About Kikoto · {APP_CLIENT_VERSION}</p>
        <h2 className="mt-1 text-2xl font-semibold">Project background and credits</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Kikoto is a local-first personal audio library focused on DLsite-style works, unified metadata, compatible
          remote sources, and browser playback.
        </p>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" />
              Built with Codex
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>This software is developed by yexca with assistance from Codex.</p>
            <p>
              v0.1.0 was developed with GPT-5.5 assistance. From v0.1.1 onward, development assistance uses
              GPT-5.6-sol.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-4 w-4" />
              Software overview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Kikoto combines local folders, DLsite metadata, and Kikoeru-compatible remote sources under one unified
              work model.
            </p>
            <p>
              It includes library browsing, favorites, circles, voice actors, workflow visibility, remote fetch flows,
              and a browser-based audio player.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderCode className="h-4 w-4" />
              Reference projects
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <div className="space-y-3">
              <p>
                Kikoto adapts to Kikoeru-compatible backends and references the public backend interface shape of
                <span className="mx-1 font-medium text-foreground">Number178/kikoeru-express</span>
                for compatibility work.
              </p>
              <Button asChild variant="outline" size="sm">
                <a href="https://github.com/Number178/kikoeru-express" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Open Kikoeru reference
                </a>
              </Button>
            </div>
            <div className="space-y-3 border-t pt-4">
              <p>
                ComfyUI informed the workflow-canvas interaction design. Kikoto does not include or adapt ComfyUI
                source code; its canvas is an independent React implementation built with @xyflow/react.
              </p>
              <Button asChild variant="outline" size="sm">
                <a href="https://github.com/comfyanonymous/ComfyUI" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Open ComfyUI reference
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4" />
              Dependencies
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            {dependencyGroups.map((group) => (
              <div key={group.title}>
                <h3 className="mb-2 font-medium text-foreground">{group.title}</h3>
                <div className="flex flex-wrap gap-2">
                  {group.items.map((item) => (
                    <span key={item} className="rounded-md border bg-background px-2 py-1 text-xs text-foreground">
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Scale className="h-4 w-4" />
              License
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Copyright (C) 2026 yexca.</p>
            <p>
              Kikoto is free software licensed under GNU AGPL v3. It is provided without warranty; the complete
              corresponding source is available in the project repository.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href="https://github.com/yexca/kikoto/blob/main/LICENSE" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Read license
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href="https://github.com/yexca/kikoto" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  View source
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={KIKOTO_RELEASES_URL} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  View releases
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
