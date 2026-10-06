import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  GitBranchPlus,
  Inbox,
  ListChecks,
  Loader2,
  X,
} from "lucide-react";

import { HeaderPopover, PopoverHeader, trayButtonClass } from "@/app/header/HeaderPopover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import { ActivityRunSummary } from "@/features/workflows/ActivityRunSummary";
import { formatRelativeTime, formatTimestamp, parseWorkflowTimestamp } from "@/features/workflows/runPresentation";
import { useStableCallback } from "@/hooks/useStableCallback";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type CurrentUser, type WorkflowNotification, type WorkflowRun } from "@/lib/api";
import { metadataIssuesURL, metadataSyncResultURL } from "@/lib/metadataMaintenance";
import { cn } from "@/lib/tailwindClassNames";

type Tab = "updates" | "attention";

const NOTIFICATION_PAGE_SIZE = 50;
const ATTENTION_PREVIEW_SIZE = 5;
const IDLE_POLL_MS = 30_000;
// While the panel shows a running job, its progress refreshes at the Activity cadence.
const RUNNING_POLL_MS = 5_000;

/**
 * The header bell: personal workflow notifications plus, for workflow operators,
 * the runs that need attention and the newest running job. Activity remains the
 * full surface; this panel only summarizes and links into it.
 */
export function NotificationCenter({
  user,
  canView,
  readOnly,
  onOpenPath,
}: {
  user: CurrentUser;
  canView: (permission: string) => boolean;
  readOnly: boolean;
  onOpenPath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const canViewWorkflows = canView("workflows:run");
  const canViewMetadataIssues = canView("metadata:sync");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("updates");
  const [notifications, setNotifications] = useState<WorkflowNotification[]>([]);
  const [notificationCount, setNotificationCount] = useState(0);
  const [notificationPage, setNotificationPage] = useState(1);
  const [notificationTotalPages, setNotificationTotalPages] = useState(1);
  const [clearableCount, setClearableCount] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [attentionRuns, setAttentionRuns] = useState<WorkflowRun[]>([]);
  const [attentionCount, setAttentionCount] = useState(0);
  const [runningCount, setRunningCount] = useState(0);
  const [runningRuns, setRunningRuns] = useState<WorkflowRun[]>([]);

  // Stable so the polling effect re-subscribes only when its inputs change,
  // while each poll reads the current page and open state.
  const refresh = useStableCallback((requestedPage: number = notificationPage) => {
    api
      .listNotifications(requestedPage, NOTIFICATION_PAGE_SIZE)
      .then((page) => {
        setNotifications(page.notifications);
        setNotificationCount(page.total);
        setNotificationPage(page.page);
        setNotificationTotalPages(page.totalPages);
        setClearableCount(page.clearableTotal);
      })
      .catch(() => {
        setNotifications([]);
        setNotificationCount(0);
        setNotificationPage(1);
        setNotificationTotalPages(1);
        setClearableCount(0);
      });
    if (!canViewWorkflows) {
      setAttentionRuns([]);
      setAttentionCount(0);
      setRunningCount(0);
      setRunningRuns([]);
      return;
    }
    api
      .listWorkflowRuns(1, ATTENTION_PREVIEW_SIZE, "attention")
      .then((page) => {
        setAttentionRuns(page.runs);
        setAttentionCount(page.total);
        const running = page.viewTotals.running;
        setRunningCount(running);
        if (running === 0) {
          setRunningRuns([]);
          return;
        }
        // The running row only renders inside the open panel.
        if (!open) return;
        return api.listWorkflowRuns(1, 1, "running").then((runningPage) => setRunningRuns(runningPage.runs));
      })
      .catch(() => {
        setAttentionRuns([]);
        setAttentionCount(0);
        setRunningCount(0);
        setRunningRuns([]);
      });
  });

  const userId = user.id;
  const pollFast = open && runningCount > 0;
  useEffect(() => {
    refresh();
    // Background tabs and a backgrounded native app skip polling and catch up on return.
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") refresh();
      },
      pollFast ? RUNNING_POLL_MS : IDLE_POLL_MS,
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [canViewWorkflows, notificationPage, pollFast, refresh, userId]);

  const unreadCount = notificationCount + attentionCount;

  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    // Land on whichever list has something to act on.
    setTab(notificationCount === 0 && attentionCount > 0 ? "attention" : "updates");
  };

  // Refresh after the open state commits so the running row is fetched too.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const go = (path: string) => {
    setOpen(false);
    onOpenPath(path);
  };

  const dismiss = async (id: number) => {
    const previous = notifications;
    const previousCount = notificationCount;
    const dismissed = notifications.find((item) => item.id === id);
    setNotifications((items) => items.filter((item) => item.id !== id));
    setNotificationCount((count) => Math.max(0, count - 1));
    if (dismissed?.status === "succeeded") setClearableCount((count) => Math.max(0, count - 1));
    try {
      await api.dismissNotification(id);
    } catch {
      setNotifications(previous);
      setNotificationCount(previousCount);
      if (dismissed?.status === "succeeded") setClearableCount((count) => count + 1);
    }
  };

  const clearSucceeded = async () => {
    if (clearing || clearableCount === 0) return;
    setClearing(true);
    try {
      await api.clearSucceededNotifications();
      setNotificationPage(1);
      await refresh(1);
    } catch (error) {
      toast.notify(toastFromError(error, t("notifications.clearFailed")));
    } finally {
      setClearing(false);
    }
  };

  const notificationPath = (notification: WorkflowNotification): string | null => {
    if (notification.type === "metadata_onboarding") {
      if (canViewMetadataIssues) {
        return metadataSyncResultURL(notification.workflowRunId, notification.status !== "succeeded", canViewWorkflows);
      }
      return canViewWorkflows ? `/workflows?activity=1&run=${notification.workflowRunId}` : "/";
    }
    if (notification.type === "availability_watch_ready") {
      return `/workflows?workflow=availability_watch&dialog=ready&run=${notification.workflowRunId}`;
    }
    if (notification.type === "remote_track" && notification.status === "failed") {
      return canViewWorkflows ? `/workflows?activity=1&run=${notification.workflowRunId}` : null;
    }
    const workPath = `/${encodeURIComponent(notification.workCode)}`;
    if (notification.type === "remote_track") {
      const trackedSource = notification.fileSourceId ? `&trackedSource=${notification.fileSourceId}` : "";
      return `${workPath}?view=tracked${trackedSource}`;
    }
    return `${workPath}?view=local`;
  };

  const attentionPath = (run: WorkflowRun) =>
    canViewMetadataIssues && (run.pendingMetadata ?? 0) > 0
      ? metadataIssuesURL(run.id)
      : `/workflows?activity=1&run=${run.id}`;

  const showAttention = canViewWorkflows && tab === "attention";

  return (
    <HeaderPopover
      open={open}
      onOpenChange={openChange}
      trigger={
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("notifications.title")}
          title={
            runningCount > 0
              ? `${t("notifications.title")} · ${t("notifications.running", { count: runningCount })}`
              : t("notifications.title")
          }
          className={cn(trayButtonClass, "relative")}
        >
          <Bell className="h-4 w-4" />
          {runningCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute bottom-2 right-2 h-2 w-2 rounded-full bg-info ring-2 ring-card motion-safe:animate-pulse sm:bottom-1 sm:right-1"
            />
          )}
          {unreadCount > 0 && (
            <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-3xs font-semibold leading-none text-primary-foreground ring-2 ring-card sm:-right-0.5 sm:-top-0.5">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      }
      align="right"
      ariaLabel={t("notifications.title")}
    >
      <div className="flex max-h-[calc(var(--visual-viewport-height)-5rem)] w-[min(24rem,calc(100vw-1rem))] max-w-full flex-col">
        <PopoverHeader
          title={t("notifications.title")}
          subtitle={
            unreadCount > 0 ? t("notifications.itemCount", { count: unreadCount }) : t("notifications.nothingNew")
          }
          action={
            tab === "updates" || !canViewWorkflows ? (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground"
                disabled={readOnly || clearing || clearableCount === 0}
                onClick={() => void clearSucceeded()}
              >
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {t("notifications.clearSucceeded")}
              </Button>
            ) : undefined
          }
        />

        {canViewWorkflows && runningCount > 0 && (
          <button
            type="button"
            className="block w-full shrink-0 border-b bg-info-surface/40 px-3 py-2.5 text-left transition-colors hover:bg-info-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => go("/workflows?activity=1")}
          >
            <span className="mb-1.5 flex items-center justify-between gap-2 text-xs font-medium text-info-foreground">
              <span className="flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" />
                {t("notifications.running", { count: runningCount })}
              </span>
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
            {runningRuns[0] && <ActivityRunSummary run={runningRuns[0]} />}
          </button>
        )}

        {canViewWorkflows && (
          <div className="shrink-0 px-3 pt-2.5">
            <div
              role="tablist"
              aria-label={t("notifications.title")}
              className={segmentedListClassName("grid w-full grid-cols-2")}
            >
              <TabButton
                selected={tab === "updates"}
                label={t("notifications.updates")}
                count={notificationCount}
                onSelect={() => setTab("updates")}
              />
              <TabButton
                selected={tab === "attention"}
                label={t("workflowActivity.attention")}
                count={attentionCount}
                onSelect={() => setTab("attention")}
              />
            </div>
          </div>
        )}

        <div role={canViewWorkflows ? "tabpanel" : undefined} className="app-scroll min-h-0 flex-1 overflow-auto p-1.5">
          {showAttention ? (
            attentionRuns.length === 0 ? (
              <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} text={t("notifications.attentionEmpty")} />
            ) : (
              <ul className="space-y-0.5">
                {attentionRuns.map((run) => (
                  <li key={`attention-${run.id}`}>
                    <button
                      type="button"
                      className="w-full rounded-md p-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
                      onClick={() => go(attentionPath(run))}
                    >
                      <ActivityRunSummary run={run} />
                      <AttentionReasons run={run} />
                    </button>
                  </li>
                ))}
                {attentionRuns.length < attentionCount && (
                  <li className="px-2 pb-1 pt-2 text-xs text-muted-foreground">
                    {t("notifications.moreInActivity", { count: attentionCount - attentionRuns.length })}
                  </li>
                )}
              </ul>
            )
          ) : notifications.length === 0 ? (
            <EmptyState icon={<Inbox className="h-5 w-5" />} text={t("notifications.empty")} />
          ) : (
            <ul className="space-y-0.5">
              {notifications.map((notification) => (
                <NotificationRow
                  key={`notification-${notification.id}`}
                  notification={notification}
                  readOnly={readOnly}
                  onOpen={() => {
                    const path = notificationPath(notification);
                    if (path) go(path);
                  }}
                  onDismiss={() => void dismiss(notification.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {!showAttention && notificationTotalPages > 1 && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
            <span>{t("notifications.pageOf", { page: notificationPage, totalPages: notificationTotalPages })}</span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={notificationPage <= 1}
                aria-label={t("collection.previousPage")}
                title={t("collection.previousPage")}
                onClick={() => setNotificationPage((page) => Math.max(1, page - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={notificationPage >= notificationTotalPages}
                aria-label={t("collection.nextPage")}
                title={t("collection.nextPage")}
                onClick={() => setNotificationPage((page) => Math.min(notificationTotalPages, page + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {canViewWorkflows && (
          <div className="shrink-0 border-t p-1.5">
            <button
              type="button"
              className="flex h-9 w-full items-center justify-center gap-2 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
              onClick={() => go(tab === "attention" ? "/workflows?activity=1" : "/workflows?activity=1&view=history")}
            >
              <Activity className="h-4 w-4" />
              {t("notifications.openActivity")}
            </button>
          </div>
        )}
      </div>
    </HeaderPopover>
  );
}

function TabButton({
  selected,
  label,
  count,
  onSelect,
}: {
  selected: boolean;
  label: string;
  count: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={segmentedItemClassName(selected, "min-w-0 justify-center px-2 text-xs")}
      onClick={onSelect}
    >
      <span className="truncate">{label}</span>
      {count > 0 && (
        <span
          className={cn(
            "rounded-full px-1.5 text-3xs font-semibold leading-4 tabular-nums",
            selected ? "bg-primary/15 text-primary" : "bg-card text-muted-foreground",
          )}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-muted">{icon}</span>
      {text}
    </div>
  );
}

function AttentionReasons({ run }: { run: WorkflowRun }) {
  const { t } = useTranslation();
  const candidates = run.pendingCandidates + run.skippedNodeRuns + run.skippedJobs;
  const metadata = run.pendingMetadata ?? 0;
  if (candidates === 0 && metadata === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap gap-1 pl-6">
      {candidates > 0 && (
        <Badge variant="warning" className="px-1.5 py-0 text-3xs">
          {t("notifications.reviewItems", { count: candidates })}
        </Badge>
      )}
      {metadata > 0 && (
        <Badge variant="warning" className="px-1.5 py-0 text-3xs">
          {t("notifications.metadataIssues", { count: metadata })}
        </Badge>
      )}
    </span>
  );
}

const toneChip = {
  success: "bg-success-surface text-success-foreground",
  error: "bg-error-surface text-error-foreground",
  info: "bg-info-surface text-info-foreground",
  neutral: "bg-muted text-muted-foreground",
} as const;

function NotificationRow({
  notification,
  readOnly,
  onOpen,
  onDismiss,
}: {
  notification: WorkflowNotification;
  readOnly: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const created = parseWorkflowTimestamp(notification.createdAt);
  const tone =
    notification.status === "succeeded"
      ? "success"
      : notification.status === "failed"
        ? "error"
        : notification.status === "queued" || notification.status === "running"
          ? "info"
          : "neutral";
  const Icon =
    notification.type === "availability_watch_ready"
      ? Bell
      : notification.type === "remote_track"
        ? GitBranchPlus
        : notification.type === "metadata_onboarding"
          ? ListChecks
          : notification.status === "succeeded"
            ? CheckCircle2
            : Download;

  return (
    <li className="group flex items-start gap-1 rounded-md transition-colors hover:bg-muted">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-3 rounded-md p-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
      >
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", toneChip[tone])}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 break-words font-medium">{notificationTitle(notification, t)}</span>
          {notification.type === "metadata_onboarding" && (
            <span className="block text-xs text-muted-foreground">
              {t(notification.status === "succeeded" ? "metadataOnboarding.complete" : "metadataOnboarding.partial")}
            </span>
          )}
          <span className="block truncate text-xs text-muted-foreground">
            {t("notifications.workflowStatus", {
              id: notification.workflowRunId,
              status: notificationStatusLabel(notification.status, t),
            })}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 flex-col items-end gap-0.5 py-1.5 pr-1">
        {created && (
          <time
            className="px-1 text-3xs tabular-nums text-muted-foreground"
            dateTime={created.toISOString()}
            title={formatTimestamp(created, locale)}
          >
            {formatRelativeTime(created, locale)}
          </time>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-full text-muted-foreground/70 hover:text-foreground group-hover:text-muted-foreground"
          aria-label={t("notifications.dismissFor", { workCode: notification.workCode })}
          title={t("notifications.dismiss")}
          disabled={readOnly}
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}

function notificationTitle(notification: WorkflowNotification, t: TFunction) {
  if (notification.type === "metadata_onboarding") {
    return t(notification.status === "succeeded" ? "metadataOnboarding.succeeded" : "metadataOnboarding.attention");
  }
  if (notification.type === "availability_watch_ready") {
    return t("notifications.availabilityReady", { workCode: notification.workCode });
  }
  if (notification.type === "remote_track") {
    return notification.status === "failed"
      ? t("notifications.remoteTrackFailed", { workCode: notification.workCode })
      : t("notifications.remoteTrackSucceeded", { workCode: notification.workCode });
  }
  return t("notifications.generic", { workCode: notification.workCode });
}

function notificationStatusLabel(status: string, t: TFunction) {
  const key =
    status === "queued"
      ? "notifications.statusQueued"
      : status === "running"
        ? "notifications.statusRunning"
        : status === "succeeded"
          ? "notifications.statusSucceeded"
          : status === "failed"
            ? "notifications.statusFailed"
            : status === "cancelled"
              ? "notifications.statusCancelled"
              : "notifications.statusUnknown";
  return t(key);
}
