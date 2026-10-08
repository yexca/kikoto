import i18n from "@/i18n";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, MoreHorizontal, RefreshCw } from "lucide-react";
import type { DirectoryRoutingRule, WorkDetail } from "@/lib/api";
import {
  type RemoteSourceAvailability,
  remoteSourceCanBrowse,
  remoteSourceTabStatus,
  type SourceTabInfo,
  sourceTabStatusClass,
  type TrackedPresenceOption,
} from "@/features/work-detail/source/sourceContextModel";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/features/work-detail/workDetailHelpers";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { TreeNode, TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import type { FilePreviewRequest } from "@/features/work-detail/dialogs/FilePreviewDialog";
import { DirectoryExplorer } from "@/features/work-detail/directory/DirectoryExplorer";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { nodeAtPath } from "@/features/work-detail/directory/directoryModel";
import { IconButton } from "@/components/ui/icon-button";
import { buttonVariants } from "@/components/ui/button";
import {
  SourceVisibilityPicker,
  sourceVisibilityIcon,
  type SourceVisibilityRow,
} from "@/components/source-visibility/SourceVisibilityPicker";
import { sourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import { sourceTabStrip, sourceTabVisibilityEntries } from "@/features/work-detail/source/sourceTabVisibility";
import { useSourceTabVisibility } from "@/features/work-detail/source/useSourceTabVisibility";

export function DirectoryLoadErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="min-h-[22rem] rounded-md border border-warning-border bg-warning-surface p-4 text-sm text-warning-foreground"
      data-testid="directory-load-error"
    >
      <div className="font-medium">{i18n.t("libraryDetail.directoryUnavailable")}</div>
      <p className="mt-1 text-warning-foreground/80">{message}</p>
      {onRetry && (
        <Button className="mt-3" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> {i18n.t("common.retry")}
        </Button>
      )}
    </div>
  );
}

export function TrackedUnforkedPanel({
  presence,
  remoteSources,
}: {
  presence?: NonNullable<WorkDetail["sourcePresence"]>[number] | null;
  remoteSources: RemoteSourceAvailability[];
}) {
  const candidates = remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
  return (
    <div className="rounded-md border border-warning-border bg-warning-surface p-4 text-sm text-warning-foreground">
      <div className="font-medium">
        {presence ? i18n.t("libraryDetail.trackedSourceNoFolder") : i18n.t("libraryDetail.noSourceLinked")}
      </div>
      <p className="mt-1 text-warning-foreground/80">
        {presence ? i18n.t("libraryDetail.trackedSourceNoFolderDescription") : i18n.t("libraryDetail.noSourceLinked")}
      </p>
      {candidates.length === 0 && (
        <Badge variant="warning" className="mt-3">
          {i18n.t("libraryDetail.noSourceLinked")}
        </Badge>
      )}
    </div>
  );
}

export function LocalSourceStatePanel({
  status,
  remoteSources,
  onSelectRemote,
}: {
  status: SourceTabInfo["status"];
  remoteSources: RemoteSourceAvailability[];
  onSelectRemote: (remote: RemoteSourceAvailability) => void;
}) {
  const availableSources = remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
  return (
    <div
      className={`rounded-md border p-4 text-sm ${status === "unavailable" ? "border-error-border bg-error-surface text-error-foreground" : "border-warning-border bg-warning-surface text-warning-foreground"}`}
    >
      <div className="font-medium">{i18n.t("libraryDetail.localFilesUnavailable")}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {availableSources.length > 0 ? (
          availableSources.map((remote) => (
            <Button key={remote.source.id} variant="outline" size="sm" onClick={() => onSelectRemote(remote)}>
              {i18n.t("detailActions.fetch")} {remote.source.displayName}
            </Button>
          ))
        ) : (
          <Badge variant={status === "unavailable" ? "error" : "warning"}>
            {status === "unavailable" ? i18n.t("detailActions.sourceUnavailable") : i18n.t("sources.title")}
          </Badge>
        )}
      </div>
    </div>
  );
}

export function RemoteSourceStatePanel({ remote }: { remote: RemoteSourceAvailability }) {
  const status = remoteSourceTabStatus(remote.summary);
  return (
    <div
      className={`rounded-md border p-4 text-sm ${status.status === "unavailable" ? "border-error-border bg-error-surface text-error-foreground" : "border-warning-border bg-warning-surface text-warning-foreground"}`}
    >
      <div className="font-medium">
        {remote.source.displayName} · {status.statusLabel}
      </div>
      {remote.summary.error && <div className="mt-1 text-xs opacity-80">{remote.summary.error}</div>}
    </div>
  );
}

export function NoSourceDirectoryPanel({
  checking,
  checkedAt,
  remoteSources,
  onRefresh,
}: {
  checking: boolean;
  checkedAt: string;
  remoteSources: RemoteSourceAvailability[];
  onRefresh: () => void;
}) {
  const availableSources = remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
  return (
    <div className="rounded-md border border-warning-border bg-warning-surface p-4 text-sm text-warning-foreground">
      <div className="font-medium">{i18n.t("libraryDetail.noSourceLinked")}</div>
      <p className="mt-1 text-warning-foreground/80">{i18n.t("libraryDetail.noSourceDirectoryDescription")}</p>
      {availableSources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {availableSources.map((remote) => (
            <Badge key={remote.source.id} variant="outline">
              {i18n.t("libraryDetail.sourceAvailable", { source: remote.source.displayName })}
            </Badge>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={checking}>
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          {i18n.t("libraryDetail.refreshSources")}
        </Button>
        {!checking && checkedAt && (
          <span className="text-xs text-warning-foreground/80">
            {i18n.t("libraryDetail.checkedAt", { time: formatDateTime(checkedAt) })}
          </span>
        )}
      </div>
    </div>
  );
}

function SourceDirectoryContent({
  emptyState,
  root,
  directoryRoutingRules,
  requestedRoutePath,
  routeRequestKey,
  currentLocationId,
  currentPlaybackKey,
  emptyLabel,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
}: {
  emptyState?: ReactNode;
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  requestedRoutePath: string[] | null;
  routeRequestKey?: string;
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  emptyLabel: string;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (request: FilePreviewRequest) => void;
}) {
  if (emptyState) return emptyState;
  return (
    <DirectoryExplorer
      root={root}
      directoryRoutingRules={directoryRoutingRules}
      routePath={requestedRoutePath ?? undefined}
      routeRequestKey={routeRequestKey}
      currentLocationId={currentLocationId}
      currentPlaybackKey={currentPlaybackKey}
      emptyLabel={emptyLabel}
      onPlayFolder={onPlayFolder}
      onPlayNext={onPlayNext}
      onAppendQueue={onAppendQueue}
      onPreview={onPreview}
    />
  );
}

function directoryRouteRequestKey(routeStateKey: string | undefined, activeKey: string, trackedPresenceKey: string) {
  return [routeStateKey ?? "", activeKey, trackedPresenceKey].join("\u0000");
}

export function SourceDirectoryPanel({
  title,
  description,
  statsLabel,
  tabs,
  activeKey,
  onActiveKeyChange,
  trackedPresenceOptions = [],
  selectedTrackedPresenceKey = "",
  onTrackedPresenceChange,
  checkingSources = false,
  checkedAt,
  onCheckSources,
  root,
  directoryRoutingRules,
  currentLocationId,
  currentPlaybackKey,
  emptyLabel,
  toolbar,
  selectionPanel,
  selectionModal,
  loadingMessage,
  emptyState,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  autoRoutePath,
  routeStateKey,
}: {
  title: string;
  description: string;
  statsLabel?: string;
  tabs: SourceTabInfo[];
  activeKey: string;
  onActiveKeyChange: (key: string) => void;
  trackedPresenceOptions?: TrackedPresenceOption[];
  selectedTrackedPresenceKey?: string;
  onTrackedPresenceChange?: (key: string) => void;
  checkingSources?: boolean;
  checkedAt?: string;
  onCheckSources?: () => void;
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  emptyLabel: string;
  toolbar?: ReactNode;
  selectionPanel?: ReactNode;
  selectionModal?: ReactNode;
  loadingMessage?: string;
  emptyState?: ReactNode;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (request: FilePreviewRequest) => void;
  autoRoutePath?: string[] | null;
  routeStateKey?: string;
}) {
  const [trackedMenuOpen, setTrackedMenuOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [requestedRoutePath, setRequestedRoutePath] = useState<string[] | null>(null);
  const [requestedRouteStateKey, setRequestedRouteStateKey] = useState(() =>
    directoryRouteRequestKey(routeStateKey, activeKey, selectedTrackedPresenceKey),
  );
  const trackedMenuRef = useRef<HTMLDivElement | null>(null);
  const mobileActionsRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavigationLayout = useMobileNavigationLayout();
  const sourceTabVisibility = useSourceTabVisibility();
  const routeRequestKey = directoryRouteRequestKey(routeStateKey, activeKey, selectedTrackedPresenceKey);
  useEffect(() => {
    setTrackedMenuOpen(false);
    setMobileActionsOpen(false);
  }, [activeKey, selectedTrackedPresenceKey]);
  useEffect(() => {
    if (requestedRouteStateKey === routeRequestKey) return;
    setRequestedRouteStateKey(routeRequestKey);
    setRequestedRoutePath(null);
  }, [requestedRouteStateKey, routeRequestKey]);
  useEffect(() => {
    if (
      requestedRouteStateKey !== routeRequestKey ||
      autoRoutePath === null ||
      autoRoutePath === undefined ||
      requestedRoutePath !== null
    )
      return;
    if (nodeAtPath(root, autoRoutePath)) setRequestedRoutePath([...autoRoutePath]);
  }, [autoRoutePath, requestedRoutePath, requestedRouteStateKey, root, routeRequestKey]);
  const effectiveRequestedRoutePath = requestedRouteStateKey === routeRequestKey ? requestedRoutePath : null;
  const content = (
    <SourceDirectoryContent
      emptyState={emptyState}
      root={root}
      directoryRoutingRules={directoryRoutingRules}
      requestedRoutePath={effectiveRequestedRoutePath}
      routeRequestKey={routeRequestKey}
      currentLocationId={currentLocationId}
      currentPlaybackKey={currentPlaybackKey}
      emptyLabel={emptyLabel}
      onPlayFolder={onPlayFolder}
      onPlayNext={onPlayNext}
      onAppendQueue={onAppendQueue}
      onPreview={onPreview}
    />
  );
  const { visibleTabs, showStrip: showSourceTabs } = sourceTabStrip(tabs, sourceTabVisibility.preferences, activeKey);
  const visibilityRows: SourceVisibilityRow[] = sourceTabVisibilityEntries(tabs, sourceTabVisibility.preferences, {
    local: i18n.t("workCard.local"),
    tracked: i18n.t("workCard.tracked"),
  }).map((entry) => ({
    key: entry.key,
    label: entry.label,
    icon: sourceVisibilityIcon(entry.key),
    mode: sourceVisibilityMode(sourceTabVisibility.preferences, entry.key),
    visible: entry.visible,
    note: entry.disabled ? i18n.t("library.sourceVisibility.disabled") : undefined,
  }));
  // A lone source has nothing to switch to: name it in the header instead of a
  // one-tab strip, and leave an unusable one to the empty state below.
  const singleSource =
    !showSourceTabs && visibleTabs.length === 1 && visibleTabs[0].status === "available" ? visibleTabs[0] : null;
  const singleSourceName =
    singleSource?.sourceName && singleSource.sourceName !== singleSource.label
      ? `${singleSource.label} · ${singleSource.sourceName}`
      : singleSource?.label;
  const tabClassName = (active: boolean) =>
    `relative inline-flex h-10 shrink-0 items-center gap-2 px-3 text-sm font-medium transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full ${
      active ? "text-foreground after:bg-primary" : "text-muted-foreground after:bg-transparent hover:text-foreground"
    }`;
  return (
    <section className="pb-4 lg:pb-8" data-testid="directory-panel">
      {/* Clip rather than hide overflow so the folder navigator can stay sticky. */}
      <div className="overflow-clip rounded-xl border bg-card">
        <div
          className={`flex min-w-0 items-center gap-3 px-4 pt-3 lg:pt-4 ${showSourceTabs ? "" : "border-b pb-2 lg:pb-3"}`}
        >
          <div className="min-w-0 flex-1">
            <h3 className="flex min-w-0 items-baseline gap-2 text-base font-semibold">
              <span className="sr-only lg:not-sr-only">{title}</span>
              {singleSource && (
                <span
                  className="inline-flex min-w-0 shrink items-center gap-1.5 self-center text-xs font-normal text-muted-foreground lg:text-sm"
                  title={`${singleSource.label}: ${singleSource.statusLabel}`}
                  data-testid="directory-single-source"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(singleSource.status)}`}
                    aria-hidden="true"
                  />
                  <span className="truncate">{singleSourceName}</span>
                </span>
              )}
              {statsLabel && (
                <span className="truncate text-xs font-normal text-muted-foreground lg:text-sm">{statsLabel}</span>
              )}
            </h3>
            <p className="sr-only lg:not-sr-only lg:mt-0.5 lg:truncate lg:text-xs lg:text-muted-foreground">
              {description}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <SourceVisibilityPicker
              title={i18n.t("libraryDetail.sourceTabVisibility")}
              rows={visibilityRows}
              align="end"
              zIndex={70}
              triggerClassName={(open) =>
                buttonVariants({
                  variant: "toolbar",
                  size: "icon-sm",
                  className: open ? "shrink-0 bg-muted" : "shrink-0",
                })
              }
              onChange={sourceTabVisibility.changeMode}
            />
            <div className="hidden shrink-0 items-center gap-1 lg:flex">
              {onCheckSources && (
                <IconButton
                  title={
                    checkingSources
                      ? i18n.t("libraryDetail.checkingSources")
                      : checkedAt
                        ? i18n.t("libraryDetail.checkSourcesLastChecked", { time: formatDateTime(checkedAt) })
                        : i18n.t("libraryDetail.checkSources")
                  }
                  onClick={onCheckSources}
                  disabled={checkingSources}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${checkingSources ? "animate-spin" : ""}`} />
                </IconButton>
              )}
            </div>
            {mobileNavigationLayout && onCheckSources && (
              <>
                <button
                  ref={mobileActionsRef}
                  type="button"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={i18n.t("libraryDetail.directoryActions")}
                  aria-haspopup="menu"
                  aria-expanded={mobileActionsOpen}
                  title={i18n.t("libraryDetail.directoryActions")}
                  onClick={() => setMobileActionsOpen((open) => !open)}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                <AnchoredPopover
                  open={mobileActionsOpen}
                  anchorRef={mobileActionsRef}
                  onOpenChange={setMobileActionsOpen}
                  className="w-52 p-1 text-sm"
                  bottomCollisionPadding={96}
                  zIndex={70}
                >
                  <div role="menu" aria-label={i18n.t("libraryDetail.directoryActions")}>
                    <button
                      role="menuitem"
                      className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
                      disabled={checkingSources}
                      onClick={() => {
                        setMobileActionsOpen(false);
                        onCheckSources();
                      }}
                    >
                      <RefreshCw className={`h-4 w-4 shrink-0 ${checkingSources ? "animate-spin" : ""}`} />
                      <span>
                        {checkingSources
                          ? i18n.t("libraryDetail.checkingSources")
                          : i18n.t("libraryDetail.checkSources")}
                      </span>
                    </button>
                  </div>
                </AnchoredPopover>
              </>
            )}
          </div>
        </div>

        {showSourceTabs && (
          <div className="app-scrollbar mt-1 flex min-w-0 items-center overflow-x-auto border-b px-2">
            {visibleTabs.map((source) =>
              source.kind === "tracked" && trackedPresenceOptions.length > 1 ? (
                <div key={source.key} ref={trackedMenuRef} className="relative flex shrink-0 items-center">
                  <button
                    className={tabClassName(source.key === activeKey)}
                    aria-pressed={source.key === activeKey}
                    onClick={() => onActiveKeyChange(source.key)}
                    title={`${source.label}: ${source.statusLabel}`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(source.status)}`}
                      aria-hidden="true"
                    />
                    <span>{source.label}</span>
                    <span className="sr-only">{source.statusLabel}</span>
                  </button>
                  <button
                    className="-ml-2 grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={i18n.t("detailActions.switchFork")}
                    aria-haspopup="menu"
                    aria-expanded={trackedMenuOpen}
                    title={i18n.t("detailActions.switchFork")}
                    onClick={() => setTrackedMenuOpen((open) => !open)}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <AnchoredPopover
                    open={trackedMenuOpen}
                    anchorRef={trackedMenuRef}
                    onOpenChange={setTrackedMenuOpen}
                    className="w-56 p-1 text-sm"
                    zIndex={70}
                  >
                    <div role="menu" aria-label={i18n.t("libraryDetail.trackedSources")}>
                      {trackedPresenceOptions.map((option) => (
                        <button
                          key={option.key}
                          role="menuitemradio"
                          aria-checked={option.key === selectedTrackedPresenceKey}
                          className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
                          onClick={() => {
                            onTrackedPresenceChange?.(option.key);
                            setTrackedMenuOpen(false);
                          }}
                        >
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(option.status)}`}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{option.label}</span>
                            <span className="block text-2xs text-muted-foreground">
                              {option.forked ? i18n.t("libraryDetail.forked") : i18n.t("libraryDetail.unforked")}
                            </span>
                          </span>
                          {option.key === selectedTrackedPresenceKey && (
                            <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                          )}
                        </button>
                      ))}
                    </div>
                  </AnchoredPopover>
                </div>
              ) : (
                <button
                  key={source.key}
                  className={tabClassName(source.key === activeKey)}
                  aria-pressed={source.key === activeKey}
                  onClick={() => onActiveKeyChange(source.key)}
                  title={`${source.label}: ${source.statusLabel}`}
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(source.status)}`}
                    aria-hidden="true"
                  />
                  <span>{source.label}</span>
                  <span className="sr-only">{source.statusLabel}</span>
                </button>
              ),
            )}
          </div>
        )}

        <div className="p-2 sm:p-3">
          {toolbar}
          {loadingMessage && (
            <div className="mb-3 rounded-md border bg-background p-3 text-sm text-muted-foreground">
              {loadingMessage}
            </div>
          )}
          {selectionPanel}
          {content}
        </div>
      </div>
      {selectionModal}
    </section>
  );
}

export function DirectoryMessage({ message }: { message: string }) {
  return <div className="mb-4 rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">{message}</div>;
}

export function DirectoryOperationBanner({
  runId,
  status,
  onOpen,
}: {
  runId: number;
  status: string;
  onOpen: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
      <div>
        <div className="font-medium">{i18n.t("libraryDetail.fileOperationInProgress")}</div>
        <div className="text-xs text-muted-foreground">
          Workflow #{runId} · {status}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onOpen}>
        {i18n.t("remoteFetch.activity")}
      </Button>
    </div>
  );
}
