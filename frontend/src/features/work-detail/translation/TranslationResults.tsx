import { useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, FileText, Inbox, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { TranslationReviewList } from "@/components/translation/TranslationReviewList";
import {
  groupTranslationItems,
  translationReviewGroup,
  translationStateBadges,
  type TranslationReviewGroup,
} from "@/components/translation/translationReviewModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CoverageBar } from "@/components/ui/coverage-bar";
import type { TranslationItem } from "@/lib/translationApi";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { cn } from "@/lib/tailwindClassNames";
import { resultsSection, resultsSections, runningProgress, type ResultsSection } from "./translateWithAIModel";

const sectionDots: Record<ResultsSection, string> = {
  review: "bg-warning",
  active: "bg-info",
  attention: "bg-error",
  history: "bg-success",
};

/**
 * One work's translation items as a record of what changed. Items that wait
 * for review or stopped come first with their actions; items in progress
 * follow with the progress of their runs; applied items are listed by
 * language and category as before → after, each category with a link to
 * where it can be changed or undone.
 */
export function TranslationResults({
  items,
  autoAccept,
  busyIds,
  onRefresh,
  onAccept,
  onReject,
  onResend,
  onOpen,
  renderLyricsPreview,
}: {
  items: readonly TranslationItem[];
  /** Whether finished items apply at once; null while the plan loads. */
  autoAccept: boolean | null;
  busyIds: ReadonlySet<number>;
  onRefresh: () => void;
  onAccept: (ids: number[]) => void;
  onReject: (ids: number[]) => void;
  onResend: (ids: number[], acknowledgeUncertain: boolean) => void;
  /** Opens where a category's applied items can be changed or undone; absent where it cannot. */
  onOpen: (group: TranslationReviewGroup) => (() => void) | undefined;
  renderLyricsPreview: (item: TranslationItem) => ReactNode;
}) {
  const { t } = useTranslation();
  const bySection = new Map<ResultsSection, TranslationItem[]>(resultsSections.map((section) => [section, []]));
  for (const item of items) {
    const section = resultsSection(item.state);
    if (section) bySection.get(section)?.push(item);
  }
  const listed = (section: ResultsSection) => bySection.get(section) ?? [];
  const count = resultsSections.reduce((sum, section) => sum + listed(section).length, 0);
  const progress = runningProgress(items);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 pt-1.5 text-sm text-muted-foreground">
            {autoAccept !== null && t(autoAccept ? "aiTranslation.resultsIntro" : "aiTranslation.reviewIntro")}
          </p>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("aiTranslation.refresh")}
            title={t("aiTranslation.refresh")}
            onClick={onRefresh}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        {progress && (
          <div className="space-y-1" role="status">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5 text-info-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t("aiTranslation.running")}
              </span>
              <span className="tabular-nums">
                {t("aiTranslation.runProgress", { done: progress.done, total: progress.total })}
              </span>
            </div>
            <CoverageBar count={progress.done} total={progress.total} />
          </div>
        )}
      </div>

      {count === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          <Inbox className="h-6 w-6" aria-hidden="true" />
          {t("aiTranslation.noResults")}
        </div>
      ) : (
        <>
          {(["review", "attention"] as const).map((section) =>
            listed(section).length > 0 ? (
              <ResultsBlock key={section} section={section} count={listed(section).length}>
                <TranslationReviewList
                  items={listed(section)}
                  mode={section}
                  busyIds={busyIds}
                  onAccept={onAccept}
                  onReject={onReject}
                  onResend={onResend}
                  renderLyricsPreview={renderLyricsPreview}
                />
              </ResultsBlock>
            ) : null,
          )}
          {listed("active").length > 0 && (
            <ResultsBlock section="active" count={listed("active").length}>
              <ActiveList items={listed("active")} />
            </ResultsBlock>
          )}
          {listed("history").length > 0 && (
            <ResultsBlock section="history" count={listed("history").length}>
              <ChangeLog items={listed("history")} onOpen={onOpen} renderLyricsPreview={renderLyricsPreview} />
            </ResultsBlock>
          )}
        </>
      )}
    </div>
  );
}

function ResultsBlock({ section, count, children }: { section: ResultsSection; count: number; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2" aria-label={t(`aiTranslation.reviewSections.${section}`)}>
      <h4 className="flex items-center gap-2 text-sm font-medium">
        <span className={cn("h-2 w-2 rounded-full", sectionDots[section])} aria-hidden="true" />
        {t(`aiTranslation.reviewSections.${section}`)}
        <span className="rounded-full bg-muted px-1.5 text-2xs tabular-nums text-muted-foreground">{count}</span>
      </h4>
      {children}
    </section>
  );
}

function useLanguageName() {
  const { t } = useTranslation();
  return (language: string) => t(metadataTagNameLanguages.find(([value]) => value === language)?.[1] ?? language);
}

/** What is queued or being written, one row each. */
function ActiveList({ items }: { items: readonly TranslationItem[] }) {
  const { t } = useTranslation();
  const languageName = useLanguageName();
  return (
    <ul className="divide-y rounded-lg border bg-card text-sm">
      {items.map((item) => (
        <li key={item.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 sm:px-4">
          <span className="w-28 shrink-0 text-xs text-muted-foreground">{languageName(item.language)}</span>
          <span className="min-w-0 flex-1 basis-40 truncate" title={item.label}>
            <span className="text-muted-foreground">
              {t(`translationReview.groups.${translationReviewGroup(item.category)}`)}
              {itemSubject(item) && " · "}
            </span>
            {itemSubject(item)}
          </span>
          {item.category === "lyrics" && item.chunks > 1 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("translationReview.chunks", { done: item.progress, total: item.chunks })}
            </span>
          )}
          <Badge variant={translationStateBadges[item.state]} className="px-1.5 py-0 text-2xs">
            {item.state === "requesting" && (
              <Loader2 className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            )}
            {t(`translationReview.states.${item.state}`)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** Applied items by language and category, as before → after. */
function ChangeLog({
  items,
  onOpen,
  renderLyricsPreview,
}: {
  items: readonly TranslationItem[];
  onOpen: (group: TranslationReviewGroup) => (() => void) | undefined;
  renderLyricsPreview: (item: TranslationItem) => ReactNode;
}) {
  const { t } = useTranslation();
  const languageName = useLanguageName();
  const languages = groupTranslationItems(items).flatMap((work) => work.languages);
  return (
    <div className="space-y-3">
      {languages.map((language) => {
        const models = [...new Set(language.groups.flatMap((group) => group.items.map((item) => item.model)))];
        return (
          <div key={language.language} className="overflow-hidden rounded-lg border bg-card">
            <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b bg-muted/30 px-3 py-1.5 sm:px-4">
              <h5 className="text-sm font-medium">{languageName(language.language)}</h5>
              {models.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t("translationReview.byLLM", { model: models.join(", ") })}
                </span>
              )}
            </div>
            <div className="divide-y">
              {language.groups.map((group) => {
                const open = onOpen(group.group);
                const affected = group.items.find((item) => item.affectedWorks)?.affectedWorks;
                return (
                  <div key={group.group} className="px-3 py-2 sm:px-4">
                    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3">
                      <h6 className="text-xs font-medium text-muted-foreground">
                        {t(`translationReview.groups.${group.group}`)}
                        <span className="ml-1.5 font-normal tabular-nums">{group.items.length}</span>
                        {group.group === "tags" && affected ? (
                          <span className="ml-2 font-normal">
                            {t("translationReview.sharedTagsAffect", { count: affected })}
                          </span>
                        ) : null}
                      </h6>
                      {open && (
                        <button
                          type="button"
                          onClick={open}
                          className="-mr-1.5 inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {t(`aiTranslation.undo.${group.group}`)}
                          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <ul className="space-y-1 pb-1">
                      {group.items.map((item) => (
                        <ChangeRow key={item.id} item={item} renderLyricsPreview={renderLyricsPreview} />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One applied item: what it read and what it wrote. */
function ChangeRow({
  item,
  renderLyricsPreview,
}: {
  item: TranslationItem;
  renderLyricsPreview: (item: TranslationItem) => ReactNode;
}) {
  const { t } = useTranslation();
  const [previewOpen, setPreviewOpen] = useState(false);
  const lyrics = item.category === "lyrics";
  const before = lyrics || item.category === "file_name" || item.category === "folder_name" ? item.label : item.source;
  const after = lyrics ? item.appliedPath : item.result;
  return (
    <li className="min-w-0">
      <div className="grid min-w-0 gap-x-2 py-1 text-sm sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-start">
        <div
          className={cn(
            "min-w-0 break-words text-muted-foreground",
            item.category === "description" && "line-clamp-3 whitespace-pre-wrap",
          )}
          title={before}
        >
          {before || "—"}
        </div>
        <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:mt-0.5 sm:block" aria-hidden="true" />
        <div
          className={cn(
            "min-w-0 break-words",
            item.category === "description" && "line-clamp-3 whitespace-pre-wrap",
            lyrics && "font-mono text-xs sm:mt-0.5",
          )}
          title={after}
        >
          <ArrowRight className="mr-1 inline h-3.5 w-3.5 text-muted-foreground sm:hidden" aria-hidden="true" />
          {after || <span className="text-muted-foreground">—</span>}
        </div>
        {lyrics ? (
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-start"
            aria-expanded={previewOpen}
            aria-label={t("translationReview.previewOf", { title: item.label })}
            onClick={() => setPreviewOpen((current) => !current)}
          >
            <FileText className="h-4 w-4" />
            {t("translationReview.preview")}
          </Button>
        ) : (
          <span className="hidden sm:block" />
        )}
      </div>
      {previewOpen && <div className="pb-2">{renderLyricsPreview(item)}</div>}
    </li>
  );
}

/** What an item names besides its category: a tag, a path, or a track. */
function itemSubject(item: TranslationItem) {
  if (item.category === "title" || item.category === "description") return "";
  return item.category === "tag" ? item.source : item.label;
}
