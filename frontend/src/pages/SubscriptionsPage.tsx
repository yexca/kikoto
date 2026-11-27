import { BellRing, Radar, Settings2, TrendingUp, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { SubNavTabs } from "@/components/ui/sub-nav";
import { ShownWorksActionMenu, ShownWorksActionStatus } from "@/components/work-collection/ShownWorksActions";
import {
  discoverCardLayout,
  DISCOVER_LAYOUT_STORE,
  useWorkCollectionLayout,
  WorkCollectionDisplayPicker,
} from "@/components/work-collection/WorkCollectionLayout";
import { openWorkDetail } from "@/lib/workDetailNavigation";
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
import { RankingsView, type RankingActionTarget } from "@/features/rankings/RankingsView";
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
  newlyAvailableCodes,
  watchLinkFromSearch,
  withExplicitSubscriptionView,
  type ReleaseFeedDayCount,
  type SubscriptionPanel,
  type SubscriptionView,
} from "@/features/subscriptions/subscriptionModel";
import { AvailabilityWatchSettings } from "@/features/workflows/availability-watch/AvailabilityWatchPanel";
import {
  AvailabilityWatchPool,
  WatchPoolActionMenu,
} from "@/features/workflows/availability-watch/AvailabilityWatchPool";
import { useAvailabilityWatch } from "@/features/workflows/availability-watch/useAvailabilityWatch";
import { useWatchTargetActions } from "@/features/workflows/availability-watch/useWatchTargetActions";
import { WatchTargetFooterButtons } from "@/features/workflows/availability-watch/WatchActionButtons";
import { useShownWorksActions } from "@/hooks/useShownWorksActions";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { NAVIGATION_EVENT, requestHistoryScrollRestoration } from "@/lib/browserHistory";
import { deviceKey, localStore } from "@/lib/clientStorage";
import type { RankingOrder } from "@/lib/rankingApi";
import { cn } from "@/lib/tailwindClassNames";
import { openWorkflowPath, openWorkflowRun } from "@/lib/workflowLinks";

const feedDaysStorageKey = deviceKey("kikoto:release-feed-days");

/** The same glyphs as the workflows that fill each view. */
const viewIcons: Record<SubscriptionView, LucideIcon> = {
  releases: BellRing,
  rankings: TrendingUp,
  watch: Radar,
};

function readFeedDays(): ReleaseFeedDayCount {
  return releaseFeedDayCount(localStore.read(feedDaysStorageKey));
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
 * Discover, where to find what to listen to next (`/discover`). New releases
 * shows new works from subscribed circles, series, and voice actors, grouped
 * by day; Rankings the tracked rankings with how they changed; and Watch the
 * shared Availability Watch pool. All three lay their cards out alike, in one
 * display choice kept apart from the Library's and shared with For you, under
 * one toolbar whose Actions, Display options, and Settings keep their places.
 * The subscriptions with their refresh schedule, the tracked rankings, and the
 * watch's configuration open in a settings dialog, a sheet on phones.
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
  const mobile = useMobileNavigationLayout();
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
  const layout = useWorkCollectionLayout(undefined, DISCOVER_LAYOUT_STORE);
  const cardLayout = discoverCardLayout(
    mobile ? layout.mobileCardMode : layout.desktopCardMode,
    !mobile,
    layout.mobileColumns,
  );
  const panels = SUBSCRIPTION_PANELS.filter((item) => item !== "watch" || canRunWorkflows);
  const activePanel = panel && panels.includes(panel) ? panel : panel ? "subscriptions" : null;
  const views = SUBSCRIPTION_VIEWS.filter((item) => item !== "watch" || canRunWorkflows);
  const activeView = views.includes(view) ? view : "releases";
  // The Watch view and the watch's settings share one watch and its poll.
  const watchState = useAvailabilityWatch(canRunWorkflows && (activeView === "watch" || activePanel === "watch"));
  const [watchTargetId, setWatchTargetId] = useState<number | null>(null);
  const [revealAvailable, setRevealAvailable] = useState(0);
  const [feedReload, setFeedReload] = useState(0);
  const [watchPreselect, setWatchPreselect] = useState<{ key: number; codes: string[] } | null>(null);
  const openRun = openWorkflowRun;
  const watchActions = useWatchTargetActions({
    onChanged: (next) => {
      if (next) watchState.setWatch(next);
      else void watchState.refresh().catch(() => undefined);
      // The feed's "Now available" cards show the same targets.
      setFeedReload((value) => value + 1);
    },
    onOpenRun: openRun,
  });
  // The watch only monitors: Check now and Remove need `metadata:sync`, and
  // Track and Fetch their own remote permission. Demo shows the pool read-only.
  const watchPermissions = readOnly
    ? null
    : { manage: canManageSchedule, track: canTrackRemote, fetch: canFetchRemote && canManageSchedule };

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
    // A notification names its run; the works that run found newly available are preselected.
    if (link.runId !== null) {
      void api
        .getWorkflowRun(link.runId)
        .then((run) => {
          const codes = newlyAvailableCodes(run.summaryJson);
          if (codes.length > 0) setWatchPreselect((current) => ({ key: (current?.key ?? 0) + 1, codes }));
        })
        .catch(() => undefined);
    }
    replaceSearch({ dialog: null, target: null, run: null });
  }, []);
  useEffect(takeWatchLink, [takeWatchLink]);

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
    // The choice lasts for this visit when local storage is unavailable.
    localStore.write(feedDaysStorageKey, String(days));
    changeFeedPage(1);
  };
  // The feed page's works can have their metadata synced and their sources
  // checked; the feed reads itself again when a run ends.
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
  // The same actions on the ranking order the view shows, which reads itself again when a run ends.
  const [rankingReload, setRankingReload] = useState(0);
  const [rankingActionTarget, setRankingActionTarget] = useState<RankingActionTarget | null>(null);
  const rankingActions = useShownWorksActions({
    onSettled: () => setRankingReload((value) => value + 1),
    onOpenRun: openRun,
  });
  const rankingActionRequests = rankingActionTarget
    ? {
        ...(canManageSchedule
          ? { metadata: () => api.syncRankingMetadata(rankingActionTarget.listId, rankingActionTarget.snapshotId) }
          : {}),
        ...(canTrackRemote && canRunWorkflows
          ? { sources: () => api.checkRankingSources(rankingActionTarget.listId, rankingActionTarget.snapshotId) }
          : {}),
      }
    : {};
  const canMark = canSubscribe && !readOnly;

  const settings = activePanel && (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-1">
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
        {/* The tabs name the panel, so it has no title bar; Close sits beside them. */}
        <Button
          variant="ghost"
          size={mobile ? "icon" : "icon-sm"}
          className={cn("shrink-0 text-muted-foreground", !mobile && "-mr-2")}
          aria-label={t("subscriptions.closeSettings")}
          title={t("subscriptions.closeSettings")}
          onClick={() => showPanel(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div
        role="tabpanel"
        id="subscriptions-settings-panel"
        aria-labelledby={`subscriptions-tab-${activePanel}`}
        className="min-w-0"
      >
        {activePanel === "subscriptions" ? (
          <SubscriptionManager
            readOnly={readOnly}
            canSubscribe={canSubscribe}
            canManageSchedule={canManageSchedule}
            canOpenRuns={canRunWorkflows}
            onOpenPath={openWorkflowPath}
            onOpenRun={openRun}
          />
        ) : activePanel === "rankings" ? (
          <RankingSettings
            rankings={rankings}
            readOnly={readOnly}
            canManage={canManageSchedule}
            canOpenRuns={canRunWorkflows}
            onOpenRun={openRun}
          />
        ) : (
          <AvailabilityWatchSettings state={watchState} readOnly={readOnly || !canManageSchedule} onOpenRun={openRun} />
        )}
      </div>
    </div>
  );

  return (
    <div className="w-full space-y-5">
      {readOnly && <DemoReadOnlyNotice />}
      <div className="min-w-0">
        <div ref={feedRef} className="min-w-0 scroll-mt-4 space-y-4">
          <div data-toast-avoid>
            <SubNavTabs
              label={t("subscriptions.views.label")}
              selected={activeView}
              onSelect={showView}
              items={views.map((item) => ({
                value: item,
                label: t(`subscriptions.views.${item}`),
                icon: viewIcons[item],
                id: `subscriptions-view-${item}`,
                controls: "subscriptions-view-panel",
                suffix:
                  item === "releases" && unread > 0 ? (
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                      {t("subscriptions.feed.unreadCount", { count: unread })}
                    </span>
                  ) : item === "rankings" && rankingsUnseen ? (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-primary"
                      title={t("subscriptions.views.rankingsUnseen")}
                    >
                      <span className="sr-only">{t("subscriptions.views.rankingsUnseen")}</span>
                    </span>
                  ) : undefined,
              }))}
              trailing={
                <>
                  {/* Every view keeps the same three controls in place. */}
                  {activeView === "releases" ? (
                    <ShownWorksActionMenu actions={feedActions} requests={feedActionRequests} />
                  ) : activeView === "rankings" ? (
                    <ShownWorksActionMenu actions={rankingActions} requests={rankingActionRequests} />
                  ) : (
                    <WatchPoolActionMenu
                      watch={watchState.watch}
                      permissions={watchPermissions}
                      actions={watchActions}
                    />
                  )}
                  {/* One display choice for every view; only the feed is paged. */}
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
                  <Button
                    variant="toolbar"
                    size="icon-sm"
                    aria-haspopup="dialog"
                    aria-expanded={Boolean(activePanel)}
                    aria-label={t("subscriptions.settings")}
                    title={t("subscriptions.settings")}
                    onClick={() => showPanel(subscriptionPanelForView(activeView))}
                  >
                    <Settings2 className="h-4 w-4" />
                  </Button>
                </>
              }
            />
          </div>
          <div role="tabpanel" id="subscriptions-view-panel" aria-labelledby={`subscriptions-view-${activeView}`}>
            {activeView === "watch" ? (
              <AvailabilityWatchPool
                state={watchState}
                actions={watchActions}
                permissions={watchPermissions}
                cardLayout={cardLayout}
                mobileColumns={layout.mobileColumns}
                desktopColumns={layout.desktopColumns}
                selectedTargetId={watchTargetId}
                onSelectTarget={setWatchTargetId}
                revealAvailable={revealAvailable}
                preselect={watchPreselect}
                onOpenRun={openRun}
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
                  canMark={canMark}
                  canWatch={!readOnly && canRunWorkflows && canManageSchedule}
                  availableActions={
                    canRunWorkflows && watchPermissions
                      ? (target) => (
                          <WatchTargetFooterButtons
                            target={target}
                            permissions={watchPermissions}
                            actions={watchActions}
                          />
                        )
                      : undefined
                  }
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
                  canOpenRuns={canRunWorkflows}
                  canMarkSeen={canSubscribe && !readOnly}
                  canMark={canMark}
                  canWatch={!readOnly && canRunWorkflows && canManageSchedule}
                  actions={rankingActions}
                  reloadKey={rankingReload}
                  cardLayout={cardLayout}
                  mobileColumns={layout.mobileColumns}
                  desktopColumns={layout.desktopColumns}
                  onListChange={changeRankingList}
                  onOrderChange={changeRankingOrder}
                  onAtChange={changeRankingAt}
                  onCompareChange={changeRankingCompare}
                  onActionTargetChange={setRankingActionTarget}
                  onOpenSettings={() => showPanel("rankings")}
                  onOpenRun={openRun}
                  onOpenWork={openRankedWork}
                />
              </section>
            )}
          </div>
        </div>
      </div>
      {settings && !mobile && (
        // One fixed height for every tab, so switching tabs never resizes the dialog.
        <Dialog
          onClose={() => showPanel(null)}
          ariaLabel={t("subscriptions.settings")}
          size="2xl"
          className="h-[min(85dvh,var(--dialog-max-height))]"
        >
          <DialogBody className="px-4">{settings}</DialogBody>
        </Dialog>
      )}
      {watchActions.dialog}
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
