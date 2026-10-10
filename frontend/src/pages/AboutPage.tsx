import { ArrowUpRight, CodeXml, RefreshCw, Scale, ScrollText, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";

import { APP_CLIENT_VERSION, githubReleaseURL } from "@/lib/appInfo";
import { api, type AppUpdate } from "@/lib/api";
import { KIKOTO_GITHUB_ENDPOINTS } from "@/lib/official-links";
import { cn } from "@/lib/tailwindClassNames";
import { NowPlayingBars } from "@/player/dock/playerControls";

// Grouped by the part of Kikoto each project informed. `area` and `note` name
// entries under about.referenceAreas and about.references.
const referenceGroups = [
  {
    area: "remoteSources",
    projects: [
      { name: "Number178/kikoeru-express", url: "https://github.com/Number178/kikoeru-express", note: "kikoeru" },
    ],
  },
  {
    area: "playbackReporting",
    projects: [
      { name: "advplyr/audiobookshelf", url: "https://github.com/advplyr/audiobookshelf", note: "audiobookshelf" },
      { name: "navidrome/navidrome", url: "https://github.com/navidrome/navidrome", note: "navidrome" },
      { name: "jellyfin/jellyfin-web", url: "https://github.com/jellyfin/jellyfin-web", note: "jellyfin" },
    ],
  },
  {
    area: "workflows",
    projects: [{ name: "comfyanonymous/ComfyUI", url: "https://github.com/comfyanonymous/ComfyUI", note: "comfy" }],
  },
  {
    area: "engineering",
    projects: [
      { name: "cherryhq/cherry-studio", url: "https://github.com/cherryhq/cherry-studio", note: "cherry" },
      { name: "astral-sh/uv", url: "https://github.com/astral-sh/uv", note: "uv" },
      { name: "tailscale/tailscale", url: "https://github.com/tailscale/tailscale", note: "tailscale" },
      { name: "grafana/grafana", url: "https://github.com/grafana/grafana", note: "grafana" },
    ],
  },
] as const;

// Stored oldest first, displayed newest first. A null bound means an open-ended range.
const aiModelHistory = [
  { from: null, to: "v0.1.0", models: ["GPT-5.5"] },
  { from: "v0.1.1", to: "v0.5.4", models: ["GPT-5.6-Sol"] },
  { from: "v0.5.5", to: "v0.6.0", models: ["GPT-6-Astra"] },
  { from: "v0.6.1", to: "v0.6.1", models: ["GPT-6-Astra", "Claude Opus 5", "Claude Fable 5.1"] },
  { from: "v0.7.0", to: "v0.7.1", models: ["Claude Opus 5.5", "GPT-6-Astra", "GPT-6-Sol"] },
  { from: "v0.8.0", to: null, models: ["Claude Opus 5.5", "GPT-6.1-Sol"] },
] as const;

const technologyGroups = [
  {
    title: "Frontend",
    items: ["React", "TypeScript", "Vite", "Tailwind CSS", "i18next", "hls.js", "lucide-react", "Radix UI Slot"],
  },
  {
    title: "Backend",
    items: [
      "Go",
      "SQLite (modernc.org/sqlite)",
      "fsnotify",
      "chardet",
      "golang.org/x/text",
      "golang.org/x/crypto",
      "golang.org/x/net",
      "golang.org/x/sys",
    ],
  },
  {
    title: "Mobile",
    items: [
      "Capacitor",
      "Android WebView",
      "AndroidX",
      "Gradle",
      "WKWebView",
      "AVKit",
      "Swift Package Manager",
      "Xcode",
    ],
  },
  {
    title: "Runtime & Delivery",
    items: ["FFmpeg", "Debian", "Docker", "Docker Compose", "GitHub Actions"],
  },
] as const;

const LICENSE_SPDX_ID = "AGPL-3.0";
const AUTHOR = "yexca";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AboutPage() {
  const { t } = useTranslation();
  const update = useAvailableUpdate();
  return (
    <div className="w-full max-w-5xl">
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <Sleeve update={update} />
        <div className="min-w-0">
          <p className="max-w-2xl text-lg leading-8 text-foreground [font-family:var(--font-heading)] sm:text-xl sm:leading-9">
            {t("about.intro")}
          </p>
          <div className="mt-8 space-y-9">
            <Track number={1} title={t("about.softwareOverview")}>
              <div className="max-w-2xl space-y-3 text-sm leading-6 text-muted-foreground">
                <p>{t("about.overviewOne")}</p>
                <p>{t("about.overviewTwo")}</p>
              </div>
            </Track>
            <Track number={2} title={t("about.builtWithAi")}>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t("about.aiCredit")}</p>
              <ModelTimeline />
            </Track>
            <Track number={3} title={t("about.technologies")}>
              <TechnologyCredits />
            </Track>
            <Track number={4} title={t("about.referenceProjects")}>
              <ReferenceCredits />
            </Track>
          </div>
          <FinePrint />
        </div>
      </div>
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

/** The record sleeve: artwork, title, edition, and the outbound project links. */
function Sleeve({ update }: { update: AppUpdate | null }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("about.label")}
      className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-5 gap-y-5 sm:grid-cols-[9rem_minmax(0,1fr)] lg:sticky lg:top-[calc(var(--header-height)+1.5rem)] lg:grid-cols-1 lg:items-start lg:self-start"
    >
      <Artwork />
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{AUTHOR}</p>
        <h2 className="mt-1 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{t("app.name")}</h2>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className="rounded-[var(--badge-radius)] border bg-card px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
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
      <ul className="col-span-2 grid grid-cols-3 gap-2 lg:col-span-1 lg:grid-cols-1 lg:gap-0 lg:divide-y lg:border-y">
        <SleeveLink href={KIKOTO_GITHUB_ENDPOINTS.repositoryURL} icon={CodeXml} label={t("about.sourceCode")} />
        <SleeveLink href={githubReleaseURL(APP_CLIENT_VERSION)} icon={ScrollText} label={t("about.releaseNotes")} />
        <SleeveLink
          href={KIKOTO_GITHUB_ENDPOINTS.licenseURL}
          icon={Scale}
          label={t("about.license")}
          meta={LICENSE_SPDX_ID}
        />
      </ul>
    </section>
  );
}

/** Cover art with a record that slides a little further out of the sleeve on hover. */
function Artwork() {
  return (
    <div className="group relative mr-[22%] lg:mr-[30%]">
      <div
        aria-hidden="true"
        className="about-record absolute inset-y-[4%] left-[22%] aspect-square lg:left-[30%] rounded-full transition-transform duration-500 ease-out group-hover:translate-x-[10%] motion-reduce:transition-none"
      />
      <img
        src="/kikoto-about-cover.webp"
        alt=""
        width={240}
        height={240}
        className="relative aspect-square w-full rounded-[var(--player-radius-cover)] border object-cover"
      />
    </div>
  );
}

function SleeveLink({
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
          "touch-target group flex min-h-11 flex-col items-center justify-center gap-1 rounded-[var(--control-radius)] border bg-card px-2 py-1.5 text-center text-xs font-medium text-foreground transition-colors hover:bg-muted active:bg-accent",
          "lg:min-h-0 lg:flex-row lg:justify-start lg:gap-3 lg:rounded-none lg:border-0 lg:bg-transparent lg:px-1 lg:py-2.5 lg:text-left lg:text-sm",
          focusRing,
        )}
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        <span className="lg:flex-1">{label}</span>
        {meta && (
          <span className="hidden text-xs font-normal tabular-nums text-muted-foreground lg:inline">{meta}</span>
        )}
        <ArrowUpRight
          aria-hidden="true"
          className="hidden h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-foreground lg:block"
        />
      </a>
    </li>
  );
}

/** A liner-notes section, numbered like a track on the record. */
function Track({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="flex items-baseline gap-3 border-b pb-2.5">
        <span aria-hidden="true" className="w-6 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {String(number).padStart(2, "0")}
        </span>
        <span className="text-base font-semibold [font-family:var(--font-heading)]">{title}</span>
      </h3>
      <div className="pt-4 sm:pl-9">{children}</div>
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
    <div className="mt-5">
      <h4 className="text-xs font-medium text-muted-foreground">{t("about.modelHistoryTitle")}</h4>
      <ol className="mt-2 divide-y divide-dashed" aria-label={t("about.modelHistoryDescription")}>
        {entries.map((entry, index) => {
          const current = index === 0;
          return (
            <li
              key={entry.from ?? "start"}
              className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 py-2 sm:grid-cols-[1rem_8.5rem_minmax(0,1fr)]"
            >
              <span className="flex h-5 items-center text-primary">
                {current && <NowPlayingBars playing className="h-3" />}
              </span>
              <p
                className={cn(
                  "text-xs leading-5 tabular-nums",
                  current ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                {versionRange(entry, t)}
              </p>
              <p
                className={cn(
                  "col-start-2 text-sm leading-5 sm:col-start-3",
                  current ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {entry.models.join(" · ")}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Reference projects as album credits: the area they informed on the left, the projects on the right. */
function ReferenceCredits() {
  const { t } = useTranslation();
  return (
    <dl className="grid gap-y-5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-x-4">
      {referenceGroups.map((group) => (
        <div key={group.area} className="min-w-0 sm:contents">
          <dt className="text-xs font-medium uppercase leading-6 tracking-[0.08em] text-muted-foreground sm:pt-1">
            {t(`about.referenceAreas.${group.area}`)}
          </dt>
          <dd className="min-w-0">
            <ul className="-mx-2">
              {group.projects.map((project) => {
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
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {t(`about.references.${project.note}`)}
                    </p>
                  </li>
                );
              })}
            </ul>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Technologies laid out like album credits: role on the left, names on the right. */
function TechnologyCredits() {
  const { t } = useTranslation();
  return (
    <dl className="grid gap-y-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-3">
      {technologyGroups.map((group) => (
        <div key={group.title} className="min-w-0 sm:contents">
          <dt className="text-xs font-medium uppercase leading-6 tracking-[0.08em] text-muted-foreground">
            {t(`about.groups.${group.title}`)}
          </dt>
          <dd>
            <ul className="flex flex-wrap gap-x-1.5 text-sm leading-6 text-foreground [&>li:not(:last-child)]:after:ml-1.5 [&>li:not(:last-child)]:after:text-muted-foreground [&>li:not(:last-child)]:after:content-['·']">
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

function FinePrint() {
  const { t } = useTranslation();
  return (
    <footer className="mt-12 space-y-2 border-t pt-4 text-xs leading-5 text-muted-foreground sm:pl-9">
      <p className="max-w-2xl font-medium text-foreground">{t("about.usageNotice")}</p>
      <p className="max-w-2xl">
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
  );
}
