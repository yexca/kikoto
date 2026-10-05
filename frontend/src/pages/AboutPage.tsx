import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  FolderCode,
  Github,
  RefreshCw,
  Scale,
  ScrollText,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";

import { APP_CLIENT_VERSION, githubReleaseURL } from "@/lib/appInfo";
import { api, type AppUpdate } from "@/lib/api";
import { KIKOTO_GITHUB_ENDPOINTS } from "@/lib/official-links";
import { cn } from "@/lib/tailwindClassNames";

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

// Stored oldest first, displayed newest first. A null bound means an open-ended range.
const aiModelHistory = [
  { from: null, to: "v0.1.0", models: ["GPT-5.5"] },
  { from: "v0.1.1", to: "v0.5.4", models: ["GPT-5.6-Sol"] },
  { from: "v0.5.5", to: "v0.6.0", models: ["GPT-6-Astra"] },
  { from: "v0.6.1", to: "v0.6.1", models: ["GPT-6-Astra", "Claude Opus 5", "Claude Fable 5.1"] },
  { from: "v0.7.0", to: null, models: ["Claude Opus 5.5", "GPT-6-Astra", "GPT-6-Sol"] },
] as const;

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

const LICENSE_SPDX_ID = "AGPL-3.0";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AboutPage() {
  const { t } = useTranslation();
  const update = useAvailableUpdate();
  return (
    <div className="theme-card-surface w-full max-w-5xl overflow-hidden rounded-lg border bg-card text-card-foreground">
      <Identity update={update} />
      <div className="grid border-t lg:grid-cols-2 lg:divide-x">
        <div className="divide-y">
          <InfoSection icon={BookOpen} title={t("about.softwareOverview")}>
            <div className="space-y-2 text-sm leading-6 text-muted-foreground">
              <p>{t("about.overviewOne")}</p>
              <p>{t("about.overviewTwo")}</p>
            </div>
          </InfoSection>
          <InfoSection icon={Sparkles} title={t("about.builtWithAi")}>
            <p className="text-sm leading-6 text-muted-foreground">{t("about.aiCredit")}</p>
            <ModelTimeline />
          </InfoSection>
        </div>
        <div className="divide-y border-t lg:border-t-0">
          <InfoSection icon={FolderCode} title={t("about.referenceProjects")}>
            <ReferenceList />
          </InfoSection>
          <InfoSection icon={Boxes} title={t("about.technologies")}>
            <TechnologyList />
          </InfoSection>
        </div>
      </div>
      <footer className="flex items-start gap-3 border-t bg-muted/35 px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5">
        <Scale className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>
          <span className="font-medium text-foreground">{t("about.copyright")}</span>{" "}
          <Trans
            i18nKey="about.licenseText"
            components={{
              license: (
                <a
                  href={KIKOTO_GITHUB_ENDPOINTS.licenseURL}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    "rounded-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground",
                    focusRing,
                  )}
                />
              ),
            }}
          />
        </p>
      </footer>
    </div>
  );
}

function useAvailableUpdate() {
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
  return update;
}

function Identity({ update }: { update: AppUpdate | null }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("about.label")}
      className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-3 p-4 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-x-5 sm:p-5"
    >
      <img
        src="/kikoto-about-cover.webp"
        alt=""
        width={240}
        height={240}
        className="aspect-square w-full rounded-[var(--player-radius-cover)] border object-cover sm:row-span-2 sm:self-start"
      />
      <div className="min-w-0">
        <h2 className="text-2xl font-semibold leading-tight tracking-tight">{t("app.name")}</h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span className="rounded-[var(--badge-radius)] border bg-background px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
            {APP_CLIENT_VERSION}
          </span>
          {update?.releaseUrl && (
            <a
              href={update.releaseUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[var(--badge-radius)] border border-info-border bg-info-surface px-2 py-0.5 text-xs font-medium text-info-foreground transition-colors hover:border-info",
                focusRing,
              )}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              {t("about.updateAvailable", { version: update.latestVersion })}
            </a>
          )}
        </div>
      </div>
      <div className="col-span-2 min-w-0 sm:col-span-1 sm:col-start-2">
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t("about.intro")}</p>
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
          <IdentityLink href={KIKOTO_GITHUB_ENDPOINTS.repositoryURL} icon={Github} label={t("about.sourceCode")} />
          <IdentityLink href={githubReleaseURL(APP_CLIENT_VERSION)} icon={ScrollText} label={t("about.releaseNotes")} />
          <IdentityLink
            href={KIKOTO_GITHUB_ENDPOINTS.licenseURL}
            icon={Scale}
            label={t("about.license")}
            meta={LICENSE_SPDX_ID}
          />
        </ul>
      </div>
    </section>
  );
}

function IdentityLink({
  href,
  icon: Icon,
  label,
  meta,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  meta?: string;
}) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "touch-target group flex min-h-11 flex-col items-center justify-center gap-1 rounded-[var(--control-radius)] border bg-background px-2 py-1.5 text-center text-xs font-medium text-foreground transition-colors hover:bg-muted active:bg-accent sm:inline-flex sm:h-[var(--control-height-sm)] sm:min-h-0 sm:flex-row sm:gap-2 sm:px-3 sm:py-0 sm:text-sm",
          focusRing,
        )}
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        {label}
        {meta && (
          <span className="hidden text-xs font-normal tabular-nums text-muted-foreground sm:inline">{meta}</span>
        )}
        <ArrowUpRight aria-hidden="true" className="hidden h-3.5 w-3.5 text-muted-foreground sm:block" />
      </a>
    </li>
  );
}

function InfoSection({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="p-4 sm:p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function versionRange(entry: (typeof aiModelHistory)[number], t: (key: string) => string) {
  if (entry.from && entry.from === entry.to) return entry.from;
  return `${entry.from ?? t("about.firstRelease")} – ${entry.to ?? t("about.present")}`;
}

function ModelTimeline() {
  const { t } = useTranslation();
  const entries = [...aiModelHistory].reverse();
  return (
    <div className="mt-4">
      <h4 className="text-xs font-medium text-muted-foreground">{t("about.modelHistoryTitle")}</h4>
      <ol className="mt-2.5" aria-label={t("about.modelHistoryDescription")}>
        {entries.map((entry, index) => {
          const current = index === 0;
          const last = index === entries.length - 1;
          return (
            <li
              key={entry.from ?? "start"}
              className="relative grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-3 pb-3 last:pb-0 sm:pb-2.5"
            >
              {!last && <span aria-hidden="true" className="absolute -bottom-2 left-[5.5px] top-3 w-px bg-border" />}
              <span
                aria-hidden="true"
                className={cn(
                  "relative mt-1 h-3 w-3 rounded-full border-2",
                  current ? "border-primary bg-primary ring-4 ring-primary/15" : "border-border bg-card",
                )}
              />
              <div className="min-w-0 sm:flex sm:items-start sm:gap-3">
                <p
                  className={cn(
                    "text-xs leading-5 tabular-nums sm:w-28 sm:shrink-0",
                    current ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
                  )}
                >
                  {versionRange(entry, t)}
                </p>
                <ul className="mt-1 flex min-w-0 flex-wrap gap-1 sm:mt-0">
                  {entry.models.map((model) => (
                    <li
                      key={model}
                      className={cn(
                        "rounded-[var(--badge-radius)] border px-1.5 text-xs leading-5",
                        current
                          ? "border-primary/25 bg-primary/10 text-foreground"
                          : "bg-background text-muted-foreground",
                      )}
                    >
                      {model}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ReferenceList() {
  const { t } = useTranslation();
  return (
    <ul className="-mx-2 -my-1.5">
      {referenceProjects.map((project) => {
        const [owner, repository] = project.name.split("/");
        return (
          <li
            key={project.name}
            className="group relative rounded-[var(--control-radius)] px-2 py-1.5 transition-colors hover:bg-muted"
          >
            <a
              href={project.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-foreground after:absolute after:inset-0 after:rounded-[var(--control-radius)] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              <span className="font-normal text-muted-foreground">{owner}/</span>
              {repository}
              <ArrowUpRight
                aria-hidden="true"
                className="ml-1 inline h-3.5 w-3.5 align-[-0.125em] text-muted-foreground transition-colors group-hover:text-foreground"
              />
            </a>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t(project.description)}</p>
          </li>
        );
      })}
    </ul>
  );
}

function TechnologyList() {
  const { t } = useTranslation();
  return (
    <dl className="grid gap-y-3 text-sm sm:grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] sm:gap-x-3 sm:gap-y-2">
      {technologyGroups.map((group) => (
        <div key={group.title} className="min-w-0 sm:contents">
          <dt className="pt-px text-xs font-medium leading-5 text-muted-foreground">
            {t(`about.groups.${group.title}`)}
          </dt>
          <dd>
            <ul className="flex flex-wrap gap-x-1.5 leading-6 text-foreground [&>li:not(:last-child)]:after:ml-1.5 [&>li:not(:last-child)]:after:text-muted-foreground [&>li:not(:last-child)]:after:content-['·']">
              {group.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </dd>
        </div>
      ))}
    </dl>
  );
}
