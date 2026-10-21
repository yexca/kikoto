import { Settings2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import {
  useWorkCollectionLayout,
  workCardLayout,
  WorkCollectionDisplayPicker,
} from "@/components/work-collection/WorkCollectionLayout";
import { openWorkCodeRoute } from "@/features/work-detail/workDetailShared";
import { ReleaseFeed } from "@/features/subscriptions/ReleaseFeed";
import { SubscriptionManager } from "@/features/subscriptions/SubscriptionManager";
import {
  RELEASE_FEED_DAY_OPTIONS,
  releaseFeedDayCount,
  releaseFeedPageFromSearch,
  SUBSCRIPTION_PANELS,
  subscriptionPanelFromSearch,
  type ReleaseFeedDayCount,
  type SubscriptionPanel,
} from "@/features/subscriptions/subscriptionModel";
import { AvailabilityWatchManager } from "@/features/workflows/availability-watch/AvailabilityWatchPanel";
import { openWorkflowPath, workflowActivityRunPath } from "@/features/workflows/workflowLinks";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

const feedDaysStorageKey = "kikoto:release-feed-days";

function readFeedDays(): ReleaseFeedDayCount {
  try {
    return releaseFeedDayCount(localStorage.getItem(feedDaysStorageKey));
  } catch {
    return releaseFeedDayCount(null);
  }
}

/** Replaces the location's query without a history entry; a null value removes the key. */
function replaceSearch(patch: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${params.size ? `?${params}` : ""}`,
  );
}

/**
 * New works from subscribed circles, series, and voice actors, grouped by day
 * in the Library's card grid, with the subscriptions, their refresh schedule,
 * and the shared Availability Watch in a settings panel beside it.
 */
export function SubscriptionsPage({
  readOnly,
  canSubscribe,
  canManageSchedule,
  canRunWorkflows,
  canTrackRemote,
  canFetchRemote,
}: {
  readOnly: boolean;
  /** `favorites:write`: subscriptions and the read state are personal. */
  canSubscribe: boolean;
  /** `metadata:sync`: the shared schedule and Availability Watch. */
  canManageSchedule: boolean;
  /** `workflows:run`: Availability Watch and run history. */
  canRunWorkflows: boolean;
  canTrackRemote: boolean;
  canFetchRemote: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const mobile = useMobileNavigationLayout();
  const [panel, setPanel] = useState<SubscriptionPanel | null>(() =>
    subscriptionPanelFromSearch(window.location.search),
  );
  const [unread, setUnread] = useState(0);
  const [feedPage, setFeedPage] = useState(() => releaseFeedPageFromSearch(window.location.search));
  const [feedDays, setFeedDays] = useState(readFeedDays);
  const feedRef = useRef<HTMLElement | null>(null);
  const layout = useWorkCollectionLayout();
  const cardLayout = workCardLayout(
    mobile ? layout.mobileCardMode : layout.desktopCardMode,
    !mobile,
    layout.mobileColumns,
  );
  const panels = SUBSCRIPTION_PANELS.filter((item) => item !== "watch" || canRunWorkflows);
  const activePanel = panel && panels.includes(panel) ? panel : panel ? "subscriptions" : null;

  useEffect(() => {
    const sync = () => {
      setPanel(subscriptionPanelFromSearch(window.location.search));
      setFeedPage(releaseFeedPageFromSearch(window.location.search));
    };
    window.addEventListener(NAVIGATION_EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const showPanel = (next: SubscriptionPanel | null) => {
    setPanel(next);
    replaceSearch({ panel: next, dialog: null, target: null, run: null });
  };
  const changeFeedPage = useCallback((next: number) => {
    setFeedPage(next);
    replaceSearch({ page: next > 1 ? String(next) : null });
    feedRef.current?.scrollIntoView({ block: "start" });
  }, []);
  const changeFeedDays = (value: number) => {
    const days = releaseFeedDayCount(value);
    setFeedDays(days);
    try {
      localStorage.setItem(feedDaysStorageKey, String(days));
    } catch {
      // The choice lasts for this visit when local storage is unavailable.
    }
    changeFeedPage(1);
  };
  const openRun = (runId: number) => openWorkflowPath(workflowActivityRunPath(runId));

  const settings = activePanel && (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div role="tablist" aria-label={t("subscriptions.settings")} className={segmentedListClassName()}>
          {panels.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`subscriptions-tab-${item}`}
              aria-selected={activePanel === item}
              aria-controls="subscriptions-settings-panel"
              className={segmentedItemClassName(activePanel === item)}
              onClick={() => showPanel(item)}
            >
              {t(`subscriptions.panels.${item}`)}
            </button>
          ))}
        </div>
        {mobile && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("subscriptions.closeSettings")}
            title={t("subscriptions.closeSettings")}
            onClick={() => showPanel(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div
        role="tabpanel"
        id="subscriptions-settings-panel"
        aria-labelledby={`subscriptions-tab-${activePanel}`}
        className="min-w-0"
      >
        {activePanel === "subscriptions" ? (
          <SubscriptionManager
            readOnly={readOnly || !canSubscribe}
            canManageSchedule={canManageSchedule}
            onOpenPath={openWorkflowPath}
            onOpenRun={openRun}
          />
        ) : (
          <AvailabilityWatchManager
            readOnly={readOnly}
            canSyncMetadata={canManageSchedule}
            canTrackRemote={canTrackRemote}
            canFetchRemote={canFetchRemote}
            onRunQueued={() => toast.success(t("subscriptions.watchQueued"))}
          />
        )}
      </div>
    </div>
  );

  return (
    <div className="w-full space-y-5">
      {readOnly && <DemoReadOnlyNotice />}
      <section ref={feedRef} className="min-w-0 scroll-mt-4 space-y-4" aria-labelledby="subscriptions-feed-heading">
        <div className="flex items-center justify-between gap-3" data-toast-avoid>
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 id="subscriptions-feed-heading" className="text-lg font-semibold">
              {t("subscriptions.feed.label")}
            </h2>
            {unread > 0 && (
              <span className="text-sm text-muted-foreground">
                {t("subscriptions.feed.unreadCount", { count: unread })}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <WorkCollectionDisplayPicker
              mobileColumns={layout.mobileColumns}
              desktopColumns={layout.desktopColumns}
              onMobileColumnsChange={layout.setMobileColumns}
              onDesktopColumnsChange={layout.setDesktopColumns}
              cardModes={{
                mobile: layout.mobileCardMode,
                desktop: layout.desktopCardMode,
                onMobileChange: layout.setMobileCardMode,
                onDesktopChange: layout.setDesktopCardMode,
              }}
              pageSize={feedDays}
              pageSizeOptions={RELEASE_FEED_DAY_OPTIONS}
              onPageSizeChange={changeFeedDays}
              pageSizeLabels={{
                heading: t("subscriptions.feed.daysPerPage"),
                value: (count) => t("subscriptions.feed.daysPerPageValue", { count }),
              }}
            />
            <Button
              variant="toolbar"
              size="icon-sm"
              aria-haspopup="dialog"
              aria-expanded={Boolean(activePanel)}
              aria-label={t("subscriptions.settings")}
              title={t("subscriptions.settings")}
              onClick={() => showPanel("subscriptions")}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <ReleaseFeed
          page={feedPage}
          days={feedDays}
          cardLayout={cardLayout}
          mobileColumns={layout.mobileColumns}
          desktopColumns={layout.desktopColumns}
          canMarkSeen={canSubscribe && !readOnly}
          canWatch={!readOnly && canRunWorkflows && canManageSchedule}
          onOpenWork={(code) => openWorkCodeRoute(code)}
          onPageChange={changeFeedPage}
          onLoaded={(page) => setUnread(page.unreadCount)}
        />
      </section>
      {settings && !mobile && (
        // A drawer over the right edge, like the Library's controls: the feed keeps its width.
        <Dialog
          onClose={() => showPanel(null)}
          ariaLabel={t("subscriptions.settings")}
          overlayClassName="!place-items-stretch !justify-items-end !p-0"
          className="!h-full !max-h-none w-[min(36rem,100vw)] !max-w-none !rounded-none border-y-0 border-r-0 slide-in-from-bottom-0 slide-in-from-right-8 zoom-in-100"
        >
          <DialogHeader
            title={t("subscriptions.settings")}
            onClose={() => showPanel(null)}
            closeLabel={t("subscriptions.closeSettings")}
          />
          <DialogBody>{settings}</DialogBody>
        </Dialog>
      )}
      {mobile && (
        <MobileSheet
          open={Boolean(settings)}
          onOpenChange={(open) => {
            if (!open) showPanel(null);
          }}
          ariaLabel={t("subscriptions.settings")}
          className="flex h-[85dvh] flex-col overflow-hidden"
        >
          <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-4">{settings}</div>
        </MobileSheet>
      )}
    </div>
  );
}
