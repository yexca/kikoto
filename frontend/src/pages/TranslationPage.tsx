import { Inbox, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { TranslationReviewList, type TranslationReviewMode } from "@/components/translation/TranslationReviewList";
import { useTranslationReviewActions } from "@/components/translation/useTranslationReviewActions";
import { Button } from "@/components/ui/button";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { MaintenanceToolbarSlots } from "@/features/maintenance/MaintenanceControls";
import { TranslationCoverage } from "@/features/maintenance/TranslationCoverage";
import {
  translationCenterViewFromSearch,
  visibleTranslationCenterViews,
  type TranslationCenterView,
} from "@/features/translation/translationCenterModel";
import { ActivityRunLink, TranslationRunList } from "@/features/translation/TranslationRunList";
import { LyricsPreview } from "@/features/work-detail/lyrics/LyricsPreview";
import { openWorkCodeRoute } from "@/features/work-detail/workDetailShared";
import { openWorkflowPath, workflowActivityRunPath } from "@/features/workflows/workflowLinks";
import { api, type TranslationCenterCounts, type TranslationItem, type TranslationRun } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

const pollMs = 4000;

const itemViews: Partial<Record<TranslationCenterView, TranslationReviewMode>> = {
  review: "review",
  attention: "attention",
  history: "history",
};

/**
 * The Translation page: Translate with AI runs that are translating or
 * queued, the items that stopped and can be sent again, what finished items
 * wrote, and how much of the library each language covers. Finished items
 * apply through acceptance; while auto-accept is off, the items waiting for
 * review are listed first. It reads runs and their items; Activity keeps the
 * runs' diagnostics.
 */
export function TranslationPage({
  canTranslateMetadata,
  canTranslateFiles,
  canOpenActivity,
}: {
  /** Titles, descriptions and shared tag names. */
  canTranslateMetadata: boolean;
  /** File and folder display names and lyrics. */
  canTranslateFiles: boolean;
  canOpenActivity: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [requestedView, setRequestedView] = useState<TranslationCenterView | null>(() =>
    translationCenterViewFromSearch(window.location.search),
  );
  const [items, setItems] = useState<TranslationItem[] | null>(null);
  const [runs, setRuns] = useState<{ active: TranslationRun[]; queued: TranslationRun[] } | null>(null);
  const [counts, setCounts] = useState<TranslationCenterCounts | null>(null);
  // Auto-accept is on until the server says otherwise.
  const [autoAccept, setAutoAccept] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [cancelling, setCancelling] = useState<ReadonlySet<number>>(new Set());
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  const views = visibleTranslationCenterViews(autoAccept, counts?.review ?? 0);
  const view = requestedView && views.includes(requestedView) ? requestedView : views[0];

  useEffect(() => {
    const sync = () => setRequestedView(translationCenterViewFromSearch(window.location.search));
    window.addEventListener(NAVIGATION_EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const mode = itemViews[view];
      const [active, queued, list] = await Promise.all([
        api.listTranslationRuns("active"),
        view === "running" ? api.listTranslationRuns("queued") : Promise.resolve(null),
        mode ? api.listTranslationItems(mode) : Promise.resolve(null),
      ]);
      setCounts(active.counts);
      setAutoAccept(active.autoAccept);
      if (queued) setRuns({ active: active.runs, queued: queued.runs });
      if (list) setItems(list.items);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [view]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const working = (counts?.active ?? 0) + (counts?.queued ?? 0) > 0;
  useEffect(() => {
    if (!working || view === "coverage") return;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [load, view, working]);

  const review = useTranslationReviewActions({ onDone: load });

  const showView = (next: TranslationCenterView) => {
    const params = new URLSearchParams({ view: next });
    window.history.replaceState(window.history.state, "", `/translation?${params}`);
    setRequestedView(next);
  };
  const cancelRun = async (runId: number) => {
    setCancelling((current) => new Set([...current, runId]));
    try {
      await api.cancelWorkflowRun(runId);
      toast.success(t("translationCenter.cancelled"));
    } catch (error) {
      toast.notify(toastFromError(error, t("translationCenter.cancelFailed")));
    } finally {
      setCancelling((current) => new Set([...current].filter((id) => id !== runId)));
      await load();
    }
  };
  const workLink = (code: string, label: ReactNode) => (
    <a
      href={`/${encodeURIComponent(code)}`}
      className="text-muted-foreground transition-colors hover:text-primary"
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openWorkCodeRoute(code);
      }}
    >
      {label}
    </a>
  );
  const activityLink = canOpenActivity
    ? (runId: number) => (
        <ActivityRunLink
          href={workflowActivityRunPath(runId)}
          label={t("translationCenter.activity")}
          onOpen={() => openWorkflowPath(workflowActivityRunPath(runId))}
        />
      )
    : undefined;
  const badge = (value: TranslationCenterView) => {
    if (!counts) return 0;
    if (value === "review") return counts.review;
    if (value === "running") return counts.active + counts.queued;
    if (value === "attention") return counts.attention;
    return 0;
  };
  const toolbar: MaintenanceToolbarSlots = { actions: actionsSlot, search: searchSlot, compactSearch: false };
  const empty = (message: string) => (
    <div className="grid min-h-48 place-items-center rounded-lg border bg-card px-6 py-10 text-center">
      <div>
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Inbox className="h-4 w-4" />
        </div>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
  const emptyMessage: Record<TranslationCenterView, string> = {
    review: t("translationCenter.noReview"),
    running: t("translationCenter.noRunning"),
    attention: t("translationCenter.noAttention"),
    history: t("translationCenter.noHistory"),
    coverage: "",
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-h-10 flex-wrap items-center gap-2" data-toast-avoid>
        <div role="tablist" aria-label={t("translationCenter.views.label")} className={segmentedListClassName()}>
          {views.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              className={segmentedItemClassName(view === value)}
              onClick={() => showView(value)}
            >
              {t(`translationCenter.views.${value}`)}
              {badge(value) > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-px text-2xs tabular-nums text-muted-foreground">
                  {badge(value)}
                </span>
              )}
            </button>
          ))}
        </div>
        {view === "coverage" ? (
          <>
            <div ref={setSearchSlot} className="contents" />
            <div ref={setActionsSlot} className="ml-auto flex shrink-0 items-center gap-2" />
          </>
        ) : (
          <Button
            className="ml-auto"
            variant="toolbar"
            size="icon-sm"
            aria-label={t("translationCenter.refresh")}
            title={t("translationCenter.refresh")}
            onClick={() => void load()}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t(`translationCenter.descriptions.${view}`)}</p>
      {loadError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
        >
          {t("translationCenter.loadFailed")}
          <Button size="sm" variant="outline" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {view === "coverage" ? (
        <TranslationCoverage
          readOnly={false}
          permissions={{ metadata: canTranslateMetadata, files: canTranslateFiles }}
          toolbar={toolbar}
        />
      ) : view === "running" ? (
        !runs ? (
          <Loading />
        ) : runs.active.length + runs.queued.length === 0 ? (
          empty(emptyMessage.running)
        ) : (
          <div className="space-y-4">
            {runs.active.length > 0 && (
              <section className="space-y-2" aria-label={t("translationCenter.running")}>
                <h3 className="text-sm font-medium">{t("translationCenter.running")}</h3>
                <TranslationRunList
                  runs={runs.active}
                  busyRunIds={cancelling}
                  onCancel={(id) => void cancelRun(id)}
                  renderWorkLink={workLink}
                  activityLink={activityLink}
                />
              </section>
            )}
            {runs.queued.length > 0 && (
              <section className="space-y-2" aria-label={t("translationCenter.queued")}>
                <h3 className="text-sm font-medium">{t("translationCenter.queued")}</h3>
                <TranslationRunList
                  runs={runs.queued}
                  busyRunIds={cancelling}
                  onCancel={(id) => void cancelRun(id)}
                  renderWorkLink={workLink}
                  activityLink={activityLink}
                />
              </section>
            )}
          </div>
        )
      ) : !items ? (
        <Loading />
      ) : items.length === 0 ? (
        empty(emptyMessage[view])
      ) : (
        <TranslationReviewList
          items={items}
          mode={itemViews[view] ?? "history"}
          showWork
          busyIds={review.busyIds}
          onAccept={(ids) => void review.accept(ids)}
          onReject={(ids) => void review.reject(ids)}
          onResend={(ids, acknowledge) => void review.resend(ids, acknowledge)}
          renderWorkLink={workLink}
          renderLyricsPreview={(item) => (
            <LyricsPreview
              label={item.label}
              loadKey={`translation:${item.id}`}
              load={() => api.translationItemText(item.id, "result")}
              durationSeconds={item.durationSeconds ?? null}
            />
          )}
        />
      )}
    </div>
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {t("translationCenter.loading")}
    </p>
  );
}
