import { Settings2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { ShownWorksActionMenu, ShownWorksActionStatus } from "@/components/work-collection/ShownWorksActions";
import {
  useWorkCollectionLayout,
  workCardLayout,
  WorkCollectionDisplayPicker,
} from "@/components/work-collection/WorkCollectionLayout";
import { openWorkDetail } from "@/app/workDetailNavigation";
import { RankingSettings } from "@/features/rankings/RankingSettings";
import {
  DEFAULT_RANKING_ORDER,
  rankingAtFromSearch,
  rankingChipKey,
  rankingCompareFromSearch,
  rankingListFromSearch,
  rankingOrderFor,
  rankingOrderFromSearch,
  rankingOrderSearch,
  rankingsUnseen as anyRankingUnseen,
} from "@/features/rankings/rankingModel";
import { readRankingOrderPreferences, writeRankingOrderPreference } from "@/features/rankings/rankingOrderPreference";
import { RankingsView } from "@/features/rankings/RankingsView";
import { useRankingOverview } from "@/features/rankings/useRankingOverview";
import { openWorkCodeRoute } from "@/features/work-detail/workDetailShared";
import { ReleaseFeed } from "@/features/subscriptions/ReleaseFeed";
import { SubscriptionManager } from "@/features/subscriptions/SubscriptionManager";
import {
  canonicalSubscriptionSearch,
  RELEASE_FEED_DAY_OPTIONS,
  releaseFeedDayCount,
  releaseFeedPageFromSearch,
  SUBSCRIPTION_PANELS,
  SUBSCRIPTION_VIEWS,
  subscriptionPanelForView,
  subscriptionPanelFromSearch,
  subscriptionViewFromSearch,
  watchLinkFromSearch,
  withExplicitSubscriptionView,
  type ReleaseFeedDayCount,
  type SubscriptionPanel,
  type SubscriptionView,
} from "@/features/subscriptions/subscriptionModel";
import { AvailabilityWatchSettings } from "@/features/workflows/availability-watch/AvailabilityWatchPanel";
import { AvailabilityWatchPool } from "@/features/workflows/availability-watch/AvailabilityWatchPool";
import { useAvailabilityWatch } from "@/features/workflows/availability-watch/useAvailabilityWatch";
import { openWorkflowPath, workflowActivityRunPath } from "@/features/workflows/workflowLinks";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useShownWorksActions } from "@/hooks/useShownWorksActions";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { NAVIGATION_EVENT, requestHistoryScrollRestoration } from "@/lib/browserHistory";
import type { RankingOrder } from "@/lib/rankingApi";
import { cn } from "@/lib/tailwindClassNames";

const feedDaysStorageKey = "kikoto:release-feed-days";
const SETTINGS_BESIDE_QUERY = "(min-width: 1280px)";
const SETTINGS_BESIDE_ID = "subscriptions-settings";

function readFeedDays(): ReleaseFeedDayCount {
  try {
    return releaseFeedDayCount(localStorage.getItem(feedDaysStorageKey));
  } catch {
    return releaseFeedDayCount(null);
  }
}

function patchedLocation(patch: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  withExplicitSubscriptionView(params);
  return `${window.location.pathname}${params.size ? `?${params}` : ""}`;
}

/** Replaces the location's query without a history entry; a null value removes the key. */
function replaceSearch(patch: Record<string, string | null>) {
  window.history.replaceState(window.history.state, "", patchedLocation(patch));
}

/** Changes the location's query in a new history entry, so Back returns to the current one at its scroll. */
function pushSearch(patch: Record<string, string | null>) {
  window.history.pushState(
    requestHistoryScrollRestoration(window.history.state, window.scrollY),
    "",
    patchedLocation(patch),
  );
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/** Opens a ranked code: its work, or a remote list's source page for a code the library lacks. */
function openRankedWork(code: string, remoteSourceId: number | null) {
  if (remoteSourceId === null) {
    openWorkCodeRoute(code);
    return;
  }
  openWorkDetail(
    { kind: "remote-only", sourceId: remoteSourceId, remoteCode: code },
    {
      returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      returnLabel: i18n.t("common.back"),
    },
  );
}

/**
 * Discover, the way in to works from outside the library (`/discover`).
 * New works from subscribed circles, series, and voice actors, grouped by day
 * in the Library's card grid; the tracked rankings with how they changed; or
 * the shared Availability Watch pool in the same card grid. The subscriptions
 * with their refresh schedule, the tracked rankings, and the watch's
 * configuration live in a settings panel beside them.
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
  const besideLayout = useMediaQuery(SETTINGS_BESIDE_QUERY);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const besideRef = useRef<HTMLElement | null>(null);
  const [panel, setPanel] = useState<SubscriptionPanel | null>(() =>
    subscriptionPanelFromSearch(window.location.search),
  );
  const [view, setView] = useState<SubscriptionView>(() => subscriptionViewFromSearch(window.location.search));
  const [rankingListId, setRankingListId] = useState(() => rankingListFromSearch(window.location.search));
  const [rankingCompare, setRankingCompare] = useState(() => rankingCompareFromSearch(window.location.search));
  const [rankingAt, setRankingAt] = useState(() => rankingAtFromSearch(window.location.search));
  const [rankingOrder, setRankingOrder] = useState(() => rankingOrderFromSearch(window.location.search));
  const [rankingOrderPreferences, setRankingOrderPreferences] = useState(readRankingOrderPreferences);
  const rankings = useRankingOverview();
  const rankingsUnseen = anyRankingUnseen(
    rankings.overview?.lists ?? [],
    rankingListId,
    rankingOrder,
    rankingOrderPreferences,
  );
  const [unread, setUnread] = useState(0);
  const [feedPage, setFeedPage] = useState(() => releaseFeedPageFromSearch(window.location.search));
  const [feedDays, setFeedDays] = useState(readFeedDays);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const layout = useWorkCollectionLayout();
  const cardLayout = workCardLayout(
    mobile ? layout.mobileCardMode : layout.desktopCardMode,
    !mobile,
    layout.mobileColumns,
  );
  const panels = SUBSCRIPTION_PANELS.filter((item) => item !== "watch" || canRunWorkflows);
  const activePanel = panel && panels.includes(panel) ? panel : panel ? "subscriptions" : null;
  const views = SUBSCRIPTION_VIEWS.filter((item) => item !== "watch" || canRunWorkflows);
  const activeView = views.includes(view) ? view : "releases";
  const settingsBeside = besideLayout && Boolean(activePanel);
  // The Watch view and the watch's settings share one watch and its poll.
  const watchState = useAvailabilityWatch(canRunWorkflows && (activeView === "watch" || activePanel === "watch"));
  const [watchTargetId, setWatchTargetId] = useState<number | null>(null);
  const [revealAvailable, setRevealAvailable] = useState(0);

  // A Watch view link that names a target or the available works hands them
  // to the view and leaves the address on the view itself.
  const takeWatchLink = useCallback(() => {
    const canonical = canonicalSubscriptionSearch(window.location.search);
    if (canonical !== null) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${canonical}${window.location.hash}`,
      );
    }
    if (subscriptionViewFromSearch(window.location.search) !== "watch") return;
    const link = watchLinkFromSearch(window.location.search);
    if (!link) return;
    if (link.targetId !== null) setWatchTargetId(link.targetId);
    if (link.revealAvailable) setRevealAvailable((value) => value + 1);
    replaceSearch({ dialog: null, target: null, run: null });
  }, []);
  useEffect(takeWatchLink, [takeWatchLink]);

  // The panel beside the feed follows the whole feed in reading order, so it
  // takes focus when it opens, as the drawer does.
  useEffect(() => {
    if (settingsBeside) besideRef.current?.focus({ preventScroll: true });
  }, [settingsBeside]);

  useEffect(() => {
    const sync = () => {
      takeWatchLink();
      setPanel(subscriptionPanelFromSearch(window.location.search));
      setFeedPage(releaseFeedPageFromSearch(window.location.search));
      setView(subscriptionViewFromSearch(window.location.search));
      setRankingListId(rankingListFromSearch(window.location.search));
      setRankingCompare(rankingCompareFromSearch(window.location.search));
      setRankingAt(rankingAtFromSearch(window.location.search));
      setRankingOrder(rankingOrderFromSearch(window.location.search));
    };
    window.addEventListener(NAVIGATION_EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, [takeWatchLink]);

  const showPanel = (next: SubscriptionPanel | null) => {
    setPanel(next);
    replaceSearch({ panel: next, dialog: null, target: null, run: null });
  };
  // Closing from inside the panel returns focus to the toolbar button.
  const closeBesideSettings = () => {
    const focusInside = besideRef.current?.contains(document.activeElement) ?? false;
    showPanel(null);
    if (focusInside) settingsButtonRef.current?.focus({ preventScroll: true });
  };
  const showView = (next: SubscriptionView) => {
    setView(next);
    setFeedPage(1);
    setRankingListId(null);
    setRankingCompare("");
    setRankingAt(null);
    setRankingOrder(null);
    setWatchTargetId(null);
    replaceSearch({
      view: next === "releases" ? null : next,
      page: null,
      list: null,
      compare: null,
      at: null,
      release: null,
      sort: null,
    });
  };
  // A chip opens in the order last chosen on it, named in the location.
  const changeRankingList = (next: number) => {
    const list = rankings.overview?.lists.find((item) => item.id === next);
    const preferred = list ? rankingOrderPreferences[rankingChipKey(list)] : undefined;
    const nextOrder = list && preferred ? rankingOrderFor(list, preferred) : null;
    setRankingListId(next);
    setRankingCompare("");
    setRankingAt(null);
    setRankingOrder(nextOrder);
    replaceSearch({
      list: String(next),
      compare: null,
      at: null,
      ...rankingOrderSearch(nextOrder ?? DEFAULT_RANKING_ORDER),
    });
  };
  // The order is a history entry of its own and is remembered for the chip.
  const changeRankingOrder = (chipKey: string, next: RankingOrder) => {
    writeRankingOrderPreference(chipKey, next);
    setRankingOrderPreferences((current) => ({ ...current, [chipKey]: next }));
    setRankingOrder(next);
    setRankingCompare("");
    pushSearch({ ...rankingOrderSearch(next), compare: null });
  };
  const changeRankingAt = (next: string | null) => {
    setRankingAt(next);
    setRankingCompare("");
    replaceSearch({ at: next, compare: null });
  };
  const changeRankingCompare = (next: string) => {
    setRankingCompare(next);
    replaceSearch({ compare: next || null });
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
  // The feed page's works can have their metadata synced and their sources
  // checked; the feed reads itself again when a run ends.
  const [feedReload, setFeedReload] = useState(0);
  const feedActions = useShownWorksActions({
    onSettled: () => setFeedReload((value) => value + 1),
    onOpenRun: openRun,
  });
  const feedActionRequests = readOnly
    ? {}
    : {
        ...(canManageSchedule ? { metadata: () => api.syncReleaseFeedMetadata(feedPage, feedDays) } : {}),
        ...(canTrackRemote && canRunWorkflows
          ? { sources: () => api.checkReleaseFeedSources(feedPage, feedDays) }
          : {}),
      };

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
        ) : activePanel === "rankings" ? (
          <RankingSettings rankings={rankings} readOnly={readOnly} canManage={canManageSchedule} onOpenRun={openRun} />
        ) : (
          <AvailabilityWatchSettings
            state={watchState}
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
      <div
        className={cn(
          "min-w-0",
          settingsBeside && "grid grid-cols-[minmax(0,1fr)_clamp(26rem,36%,36rem)] items-start gap-4",
        )}
      >
        <div ref={feedRef} className="min-w-0 scroll-mt-4 space-y-4">
          <div className="flex items-center justify-between gap-3" data-toast-avoid>
            <div role="tablist" aria-label={t("subscriptions.views.label")} className={segmentedListClassName()}>
              {views.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  id={`subscriptions-view-${item}`}
                  aria-selected={activeView === item}
                  aria-controls="subscriptions-view-panel"
                  className={segmentedItemClassName(activeView === item)}
                  onClick={() => showView(item)}
                >
                  {t(`subscriptions.views.${item}`)}
                  {item === "releases" && unread > 0 && (
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                      {t("subscriptions.feed.unreadCount", { count: unread })}
                    </span>
                  )}
                  {item === "rankings" && rankingsUnseen && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-primary"
                      title={t("subscriptions.views.rankingsUnseen")}
                    >
                      <span className="sr-only">{t("subscriptions.views.rankingsUnseen")}</span>
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {activeView === "releases" && (
                <ShownWorksActionMenu actions={feedActions} requests={feedActionRequests} />
              )}
              {activeView !== "rankings" && (
                // New releases and Watch share the Library's card grid; only the feed is paged.
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
                  {...(activeView === "releases"
                    ? {
                        pageSize: feedDays,
                        pageSizeOptions: RELEASE_FEED_DAY_OPTIONS,
                        onPageSizeChange: changeFeedDays,
                        pageSizeLabels: {
                          heading: t("subscriptions.feed.daysPerPage"),
                          value: (count: number) => t("subscriptions.feed.daysPerPageValue", { count }),
                        },
                      }
                    : {})}
                />
              )}
              <Button
                ref={settingsButtonRef}
                variant="toolbar"
                size="icon-sm"
                aria-haspopup={besideLayout ? undefined : "dialog"}
                aria-controls={settingsBeside ? SETTINGS_BESIDE_ID : undefined}
                aria-expanded={Boolean(activePanel)}
                aria-label={t("subscriptions.settings")}
                title={t("subscriptions.settings")}
                onClick={() =>
                  settingsBeside ? closeBesideSettings() : showPanel(subscriptionPanelForView(activeView))
                }
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div role="tabpanel" id="subscriptions-view-panel" aria-labelledby={`subscriptions-view-${activeView}`}>
            {activeView === "watch" ? (
              <AvailabilityWatchPool
                state={watchState}
                readOnly={readOnly}
                canSyncMetadata={canManageSchedule}
                canTrackRemote={canTrackRemote}
                canFetchRemote={canFetchRemote}
                cardLayout={cardLayout}
                mobileColumns={layout.mobileColumns}
                desktopColumns={layout.desktopColumns}
                selectedTargetId={watchTargetId}
                onSelectTarget={setWatchTargetId}
                revealAvailable={revealAvailable}
              />
            ) : activeView === "releases" ? (
              <section className="min-w-0 space-y-4" aria-label={t("subscriptions.feed.label")}>
                <ShownWorksActionStatus actions={feedActions} onOpenRun={openRun} />
                <ReleaseFeed
                  page={feedPage}
                  days={feedDays}
                  cardLayout={cardLayout}
                  mobileColumns={layout.mobileColumns}
                  desktopColumns={layout.desktopColumns}
                  canMarkSeen={canSubscribe && !readOnly}
                  canWatch={!readOnly && canRunWorkflows && canManageSchedule}
                  sourceCheck={feedActions.sourceCheck}
                  reloadKey={feedReload}
                  onOpenWork={(code) => openWorkCodeRoute(code)}
                  onPageChange={changeFeedPage}
                  onLoaded={(page) => setUnread(page.unreadCount)}
                />
              </section>
            ) : (
              <section className="min-w-0" aria-label={t("subscriptions.views.rankings")}>
                <RankingsView
                  rankings={rankings}
                  listId={rankingListId}
                  at={rankingAt}
                  compare={rankingCompare}
                  order={rankingOrder}
                  orderPreferences={rankingOrderPreferences}
                  readOnly={readOnly}
                  canManage={canManageSchedule}
                  canMarkSeen={canSubscribe && !readOnly}
                  canWatch={!readOnly && canRunWorkflows && canManageSchedule}
                  canCheckSources={!readOnly && canRunWorkflows && canTrackRemote}
                  onListChange={changeRankingList}
                  onOrderChange={changeRankingOrder}
                  onAtChange={changeRankingAt}
                  onCompareChange={changeRankingCompare}
                  onOpenSettings={() => showPanel("rankings")}
                  onOpenRun={openRun}
                  onOpenWork={openRankedWork}
                />
              </section>
            )}
          </div>
        </div>
        {settingsBeside && (
          // From 1280px the panel sits beside the feed, which reflows to the
          // remaining width. A sticky panel contains its descendants' stacking,
          // so it rises to the dialog layer while a dialog opened from it is up.
          <aside
            ref={besideRef}
            id={SETTINGS_BESIDE_ID}
            aria-label={t("subscriptions.settings")}
            tabIndex={-1}
            className="theme-card-surface sticky top-[calc(var(--header-height)+1rem)] flex max-h-[calc(100dvh-var(--header-height)-2rem-var(--app-content-bottom-clearance))] flex-col overflow-hidden rounded-lg border bg-card outline-none duration-200 animate-in fade-in-0 slide-in-from-right-8 has-[[aria-modal=true]]:z-overlay"
            onKeyDown={(event) => {
              // Escape in a portaled popover or a dialog opened from the panel belongs to that layer.
              const target = event.target as Element;
              if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(target)) return;
              if (target.closest("[aria-modal='true']")) return;
              closeBesideSettings();
            }}
          >
            <DialogHeader
              title={t("subscriptions.settings")}
              onClose={closeBesideSettings}
              closeLabel={t("subscriptions.closeSettings")}
            />
            <DialogBody>{settings}</DialogBody>
          </aside>
        )}
      </div>
      {settings && !mobile && !besideLayout && (
        // Narrower desktops keep a drawer over the right edge, like the Library's controls: the feed keeps its width.
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
