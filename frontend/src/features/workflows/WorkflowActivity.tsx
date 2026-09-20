import { Activity, Check, ChevronLeft, ChevronRight, ExternalLink, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { api, type WorkflowRun, type WorkflowRunsPage } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { openMetadataIssues } from "@/lib/metadataMaintenance";
import { activityViewForRun } from "./activityModel";

export function WorkflowActivity({ readOnly, canSyncMetadata }: { readOnly: boolean; canSyncMetadata: boolean }) {
  const { t } = useTranslation();
  const mobile = useMobileNavigationLayout();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"attention" | "history">("attention");
  const [page, setPage] = useState(1);
  const [snapshot, setSnapshot] = useState<{ view: string; page: number; result: WorkflowRunsPage } | null>(null);
  const [active, setActive] = useState<WorkflowRunsPage | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [actionError, setActionError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [totals, setTotals] = useState({ running: 0, attention: 0, history: 0 });

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || document.hidden || controller.signal.aborted) return;
      fetching = true;
      try {
        const result = await api.listWorkflowRuns(
          open ? page : 1,
          open ? 8 : 1,
          open ? view : "attention",
          "",
          "",
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setTotals({
          running: result.viewTotals?.running ?? 0,
          attention: result.viewTotals?.attention ?? 0,
          history: result.viewTotals?.history ?? 0,
        });
        if (open) {
          if (page > 1 && result.total <= (page - 1) * 8) {
            setPage(Math.max(1, Math.ceil(result.total / 8)));
            return;
          }
          setSnapshot({ view, page, result });
          const running = await api.listWorkflowRuns(1, 5, "running", "", "", controller.signal);
          if (controller.signal.aborted) return;
          setActive(running);
        }
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        fetching = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), open ? 5000 : 15000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [open, view, page, revision]);

  const navigate = (path: string) => {
    setOpen(false);
    window.history.pushState({}, "", path);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (!value) anchorRef.current?.focus({ preventScroll: true });
  };
  const acknowledge = async (run: WorkflowRun) => {
    if (readOnly || busy !== null) return;
    setBusy(run.id);
    setActionError(false);
    try {
      await api.reviewWorkflowRun(run.id);
      setRevision((value) => value + 1);
    } catch {
      setActionError(true);
    } finally {
      setBusy(null);
    }
  };
  const runRow = (run: WorkflowRun, running = false) => (
    <div key={run.id} className="space-y-2 rounded-lg border bg-card p-3">
      <button
        className="w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => navigate(`/activity?view=${activityViewForRun(run)}&run=${run.id}`)}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 break-words text-sm font-medium">
            {t(`workflowPage.builtInDefinitions.${run.workflowCode}.name`, { defaultValue: run.displayName })}
          </span>
          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>#{run.id}</span>
          <Badge
            variant={
              running ? "info" : run.status === "failed" ? "error" : run.status === "succeeded" ? "success" : "outline"
            }
          >
            {t(`workflowActivity.status.${run.status}`, { defaultValue: run.status })}
          </Badge>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">{run.finishedAt || run.startedAt || run.createdAt}</div>
        {running && (
          <div className="mt-2 text-xs text-muted-foreground">
            {t("workflowActivity.progress", { current: run.completedJobs, total: run.jobCount })}
            {run.progressBytesTotal > 0 && (
              <progress
                className="mt-2 h-1.5 w-full accent-primary"
                max={run.progressBytesTotal}
                value={run.progressBytesCurrent}
              />
            )}
          </div>
        )}
      </button>
      {(run.pendingMetadata ?? 0) > 0 && (
        <div className="text-xs text-warning-foreground">
          {t("workflowActivity.metadataCount", { count: run.pendingMetadata })}
        </div>
      )}
      {(run.pendingMetadata ?? 0) > 0 && canSyncMetadata && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setOpen(false);
            openMetadataIssues(run.id);
          }}
        >
          {t("metadataIssues.openIssues")}
        </Button>
      )}
      {!running &&
        view === "attention" &&
        run.status === "failed" &&
        run.pendingCandidates === 0 &&
        !(run.pendingMetadata ?? 0) &&
        !readOnly && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void acknowledge(run)}>
            {busy === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {t("workflowActivity.acknowledge")}
          </Button>
        )}
    </div>
  );
  const displayed = snapshot?.view === view && snapshot.page === page ? snapshot.result : null;
  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div>
          <h2 className="font-semibold">{t("nav.activity")}</h2>
          <p className="text-xs text-muted-foreground">{t("workflowActivity.allWorkflows")}</p>
        </div>
        {!mobile && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("workflowActivity.close")}
            onClick={() => changeOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {(error || actionError) && (
          <div
            role="alert"
            className="rounded-md border border-error-border bg-error-surface p-3 text-sm text-error-foreground"
          >
            {t("errors.unavailable")}{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setActionError(false);
                setRevision((value) => value + 1);
              }}
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        {totals.running > 0 && (
          <section aria-label={t("workflowActivity.running")} className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("workflowActivity.running")} · {totals.running}
            </div>
            {active?.runs.map((run) => runRow(run, true))}
            {totals.running > 5 && (
              <Button size="sm" variant="ghost" onClick={() => navigate("/activity")}>
                {t("workflowActivity.allRunning")}
              </Button>
            )}
          </section>
        )}
        <div
          role="tablist"
          aria-label={t("workflowActivity.categories")}
          className="flex gap-1 rounded-lg bg-muted/40 p-1"
        >
          {(["attention", "history"] as const).map((value) => (
            <Button
              key={value}
              role="tab"
              aria-selected={view === value}
              variant={view === value ? "secondary" : "ghost"}
              className="min-w-0 flex-1 px-2 text-xs"
              onClick={() => {
                setView(value);
                setPage(1);
              }}
            >
              {t(`workflowActivity.${value}`)} <span className="text-muted-foreground">{totals[value]}</span>
            </Button>
          ))}
        </div>
        {!displayed && !error ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {t("workManagement.loading")}
          </p>
        ) : displayed?.runs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t(`workflowActivity.empty.${view}`)}</p>
        ) : (
          <div className="space-y-2">{displayed?.runs.map((run) => runRow(run))}</div>
        )}
        {displayed && displayed.total > 8 && (
          <div className="flex items-center justify-between">
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("workflowActivity.previous")}
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground">
              {page} / {Math.ceil(displayed.total / 8)}
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("workflowActivity.next")}
              disabled={page * 8 >= displayed.total}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t p-2">
        <Button variant="ghost" className="w-full" onClick={() => navigate("/activity")}>
          {t("workflowActivity.fullActivity")}
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        className="h-11 shrink-0 gap-2 px-3"
        aria-label={t("nav.activity")}
        title={t("nav.activity")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        {totals.running > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
        <span className="hidden lg:inline">{t("nav.activity")}</span>
        {totals.attention > 0 && <Badge variant="warning">{totals.attention}</Badge>}
      </Button>
      {mobile ? (
        <MobileSheet
          open={open}
          onOpenChange={changeOpen}
          ariaLabel={t("nav.activity")}
          className="flex h-[85dvh] flex-col overflow-hidden"
        >
          {content}
        </MobileSheet>
      ) : (
        <AnchoredPopover
          open={open}
          anchorRef={anchorRef}
          onOpenChange={changeOpen}
          ariaLabel={t("nav.activity")}
          className="flex h-[min(720px,calc(100dvh-8rem))] w-[380px] flex-col overflow-hidden"
        >
          {content}
        </AnchoredPopover>
      )}
    </>
  );
}
