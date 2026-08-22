import { BookOpen, Boxes, Download, FolderCode, Github, Scale, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { APP_CLIENT_VERSION, githubReleaseURL } from "@/lib/appInfo";
import { api, type AppUpdate } from "@/lib/api";
import { KIKOTO_GITHUB_ENDPOINTS } from "@/lib/official-links";

const referenceProjects = [
  {
    name: "Number178/kikoeru-express",
    url: "https://github.com/Number178/kikoeru-express",
    description: "about.kikoeruReference",
  },
  {
    name: "comfyanonymous/ComfyUI",
    url: "https://github.com/comfyanonymous/ComfyUI",
    description: "about.comfyReference",
  },
  {
    name: "cherryhq/cherry-studio",
    url: "https://github.com/cherryhq/cherry-studio",
    description: "about.cherryReference",
  },
] as const;

const technologyGroups = [
  {
    title: "Frontend",
    items: ["React", "TypeScript", "Vite", "Tailwind CSS", "i18next", "@xyflow/react", "lucide-react", "Radix UI Slot"],
  },
  {
    title: "Backend",
    items: ["Go", "SQLite (modernc.org/sqlite)", "fsnotify", "chardet", "golang.org/x/text", "golang.org/x/crypto"],
  },
  {
    title: "Mobile",
    items: ["Capacitor", "Android WebView", "AndroidX", "Gradle"],
  },
  {
    title: "Runtime & Delivery",
    items: ["FFmpeg", "Docker", "Docker Compose", "GitHub Actions"],
  },
] as const;

export function AboutPage() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .appUpdate()
      .then((result) => {
        if (active && result.updateAvailable) setUpdate(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="space-y-5">
      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
              <span>{t("about.label")}</span>
              <span aria-hidden="true">·</span>
              <a
                href={githubReleaseURL(APP_CLIENT_VERSION)}
                target="_blank"
                rel="noreferrer"
                title={t("about.viewRelease", { version: APP_CLIENT_VERSION })}
                className="rounded-sm underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {APP_CLIENT_VERSION}
              </a>
              {update?.releaseUrl && (
                <a
                  href={update.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("about.updateAvailable", { version: update.latestVersion })}
                  title={t("about.updateAvailable", { version: update.latestVersion })}
                  className="rounded-sm text-info transition-colors hover:text-info/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Download className="h-4 w-4" />
                </a>
              )}
            </p>
            <h2 className="mt-1 text-2xl font-semibold">{t("about.title")}</h2>
          </div>
          <a
            href={KIKOTO_GITHUB_ENDPOINTS.repositoryURL}
            target="_blank"
            rel="noreferrer"
            aria-label={t("about.openRepository")}
            title={t("about.openRepository")}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Github className="h-5 w-5" />
          </a>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{t("about.intro")}</p>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" />
              {t("about.builtWithCodex")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>{t("about.codexCredit")}</p>
            <p>{t("about.modelCredit")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-4 w-4" />
              {t("about.softwareOverview")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>{t("about.overviewOne")}</p>
            <p>{t("about.overviewTwo")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderCode className="h-4 w-4" />
              {t("about.referenceProjects")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {referenceProjects.map((project) => (
                <li key={project.name} className="flex items-start gap-2 py-3 first:pt-0 last:pb-0">
                  <Github className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <p className="min-w-0 leading-6 text-muted-foreground">
                    <a
                      href={project.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-sm font-medium text-foreground underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {project.name}
                    </a>
                    {": "}
                    {t(project.description)}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4" />
              {t("about.technologies")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            {technologyGroups.map((group) => (
              <div key={group.title}>
                <h3 className="mb-2 font-medium text-foreground">{t(`about.groups.${group.title}`)}</h3>
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
              {t("about.license")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>{t("about.copyright")}</p>
            <p>
              <Trans
                i18nKey="about.licenseText"
                components={{
                  license: (
                    <a
                      href={KIKOTO_GITHUB_ENDPOINTS.licenseURL}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  ),
                }}
              />
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
