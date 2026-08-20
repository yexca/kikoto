import { BookOpen, Boxes, Download, ExternalLink, FolderCode, Scale, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { APP_CLIENT_VERSION, KIKOTO_RELEASES_URL } from "@/lib/appInfo";
import { api, type AppUpdate } from "@/lib/api";
import { KIKOTO_GITHUB_ENDPOINTS } from "@/lib/official-links";

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
        <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span>{t("about.label", { version: APP_CLIENT_VERSION })}</span>
          {update?.releaseUrl && (
            <a
              href={update.releaseUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={t("about.updateAvailable", { version: update.latestVersion })}
              title={t("about.updateAvailable", { version: update.latestVersion })}
              className="text-info hover:text-info/80"
            >
              <Download className="h-4 w-4" />
            </a>
          )}
        </p>
        <h2 className="mt-1 text-2xl font-semibold">{t("about.title")}</h2>
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
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <div className="space-y-3">
              <p>
                {t("about.kikoeruReference")}{" "}
                <span className="mx-1 font-medium text-foreground">Number178/kikoeru-express</span>.
              </p>
              <Button asChild variant="outline" size="sm">
                <a href="https://github.com/Number178/kikoeru-express" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("about.openKikoeru")}
                </a>
              </Button>
            </div>
            <div className="space-y-3 border-t pt-4">
              <p>{t("about.comfyReference")}</p>
              <Button asChild variant="outline" size="sm">
                <a href="https://github.com/comfyanonymous/ComfyUI" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("about.openComfy")}
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4" />
              {t("about.dependencies")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            {dependencyGroups.map((group) => (
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
            <p>{t("about.licenseText")}</p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={KIKOTO_GITHUB_ENDPOINTS.licenseURL} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("about.readLicense")}
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={KIKOTO_GITHUB_ENDPOINTS.repositoryURL} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("about.viewSource")}
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={KIKOTO_RELEASES_URL} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("about.viewReleases")}
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
