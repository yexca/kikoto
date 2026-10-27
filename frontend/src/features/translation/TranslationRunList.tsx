import { ExternalLink, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TranslationRun, TranslationRunLanguage } from "@/lib/translationApi";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { runLanguageStage, runStatusBadge } from "./translationCenterModel";

/**
 * Translate with AI runs by work: one row per language with its stage and
 * progress.
 */
export function TranslationRunList({
  runs,
  busyRunIds = new Set<number>(),
  onCancel,
  renderWorkLink,
  activityLink,
}: {
  runs: readonly TranslationRun[];
  busyRunIds?: ReadonlySet<number>;
  onCancel?: (runId: number) => void;
  renderWorkLink: (workCode: string, label: ReactNode) => ReactNode;
  /** Opens a run's diagnostics in Activity, for accounts that run workflows. */
  activityLink?: (runId: number) => ReactNode;
}) {
  const { t } = useTranslation();
  const languageName = (language: string) =>
    t(metadataTagNameLanguages.find(([value]) => value === language)?.[1] ?? language);
  return (
    <ul className="space-y-3">
      {runs.map((run) => {
        const live = run.status === "running" || run.status === "queued";
        return (
          <li key={run.runId} className="overflow-hidden rounded-lg border bg-card">
            <div className="flex min-h-12 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 sm:px-4">
              <div className="min-w-0 flex-1 basis-48">
                <div className="flex min-w-0 items-baseline gap-2 text-sm">
                  {renderWorkLink(run.workCode, <span className="font-mono text-xs">{run.workCode}</span>)}
                  <span className="min-w-0 truncate font-medium" title={run.workTitle}>
                    {run.workTitle}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant={runStatusBadge(run.status)} className="px-1.5 py-0 text-2xs">
                    {run.status === "running" && <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />}
                    {t(`translationCenter.runStatus.${run.status}`, { defaultValue: run.status })}
                  </Badge>
                  {run.requestedBy && <span>{t("translationReview.requestedBy", { name: run.requestedBy })}</span>}
                  <span className="tabular-nums">{run.finishedAt || run.createdAt}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {activityLink?.(run.runId)}
                {live && run.canCancel && onCancel && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyRunIds.has(run.runId)}
                    onClick={() => onCancel(run.runId)}
                  >
                    <X className="h-4 w-4" />
                    {t("translationCenter.cancel")}
                  </Button>
                )}
              </div>
            </div>
            <div className="divide-y text-sm">
              {run.languages.map((language) => (
                <LanguageRow key={language.language} language={language} name={languageName(language.language)} />
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function LanguageRow({ language, name }: { language: TranslationRunLanguage; name: string }) {
  const { t } = useTranslation();
  const stage = runLanguageStage(language);
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 pl-9 sm:px-4 sm:pl-10">
      <span className="min-w-0 flex-1">{name}</span>
      <span className="tabular-nums text-muted-foreground">{t(`translationCenter.stages.${stage.stage}`, stage)}</span>
      {stage.stage === "translating" && language.chunks > 0 && (
        <ProgressBar value={language.chunksDone} total={language.chunks} />
      )}
    </div>
  );
}

function ProgressBar({ value, total }: { value: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <span
      className="relative h-1.5 w-24 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${percent}%` }} />
    </span>
  );
}

/** A link that opens a run in Activity. */
export function ActivityRunLink({ href, onOpen, label }: { href: string; onOpen: () => void; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen();
      }}
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </a>
  );
}
