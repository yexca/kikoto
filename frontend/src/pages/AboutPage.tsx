import { BookOpen, Boxes, FolderCode, Github, History, RefreshCw, Scale, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
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

// Ordered oldest first. A null bound means the range is open-ended.
const aiModelHistory = [
  { from: null, to: "v0.1.0", models: ["GPT-5.5"] },
  { from: "v0.1.1", to: "v0.5.4", models: ["GPT-5.6-Sol"] },
  { from: "v0.5.5", to: "v0.6.0", models: ["GPT-6-Astra"] },
  { from: "v0.6.1", to: null, models: ["GPT-6-Astra", "Claude Opus 5"] },
] as const;

const currentAiModels = aiModelHistory[aiModelHistory.length - 1];

const technologyGroups = [
  {
    title: "Frontend",
    items: ["React", "TypeScript", "Vite", "Tailwind CSS", "i18next", "lucide-react", "Radix UI Slot"],
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
  const [modelHistoryOpen, setModelHistoryOpen] = useState(false);
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
                  <RefreshCw className="h-4 w-4" />
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
              {t("about.builtWithAi")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>{t("about.aiCredit")}</p>
            <p>
              {t("about.currentModels", { version: currentAiModels.from, models: currentAiModels.models.join(", ") })}
            </p>
            <Button size="sm" variant="outline" onClick={() => setModelHistoryOpen(true)}>
              <History className="h-4 w-4" />
              {t("about.viewModelHistory")}
            </Button>
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
      {modelHistoryOpen && <ModelHistoryDialog onClose={() => setModelHistoryOpen(false)} />}
    </div>
  );
}

function ModelHistoryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onClose} size="lg">
      <DialogHeader
        title={t("about.modelHistoryTitle")}
        description={t("about.modelHistoryDescription")}
        icon={<Sparkles className="h-4 w-4" />}
        onClose={onClose}
        closeLabel={t("common.close")}
      />
      <DialogBody className="p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-muted/35 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-5 py-2.5 font-medium">
                {t("about.versionColumn")}
              </th>
              <th scope="col" className="px-5 py-2.5 font-medium">
                {t("about.modelColumn")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {aiModelHistory.map((entry) => (
              <tr key={entry.from ?? "start"}>
                <td className="whitespace-nowrap px-5 py-3 tabular-nums">
                  {`${entry.from ?? t("about.firstRelease")} – ${entry.to ?? t("about.present")}`}
                </td>
                <td className="px-5 py-3">
                  <div className="flex flex-wrap gap-2">
                    {entry.models.map((model) => (
                      <span key={model} className="rounded-md border bg-background px-2 py-1 text-xs text-foreground">
                        {model}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogBody>
    </Dialog>
  );
}
