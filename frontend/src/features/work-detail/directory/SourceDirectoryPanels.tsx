import i18n from "@/i18n";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, Folder, FolderTree, MoreHorizontal, RefreshCw } from "lucide-react";
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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode, TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import type { FilePreviewState } from "@/features/work-detail/dialogs/FilePreviewDialog";
import { DirectoryBrowser, DirectoryTree } from "@/features/work-detail/directory/DirectoryTree";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Card, CardContent } from "@/components/ui/card";
import {
  type DirectoryRouteMatch,
  directoryRouteSummary,
  nodeAtPath,
} from "@/features/work-detail/directory/directoryModel";
import { IconButton } from "@/components/ui/icon-button";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";

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

export type DirectoryMode = "browse" | "tree";

function SourceDirectoryContent({
  emptyState,
  directoryMode,
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
  directoryMode: DirectoryMode;
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
  onPreview?: (preview: FilePreviewState) => void;
}) {
  if (emptyState) return emptyState;
  const sharedProps = {
    root,
    directoryRoutingRules,
    currentLocationId,
    currentPlaybackKey,
    emptyLabel,
    onPlayFolder,
    onPlayNext,
    onAppendQueue,
    onPreview,
  };
  return directoryMode === "browse" ? (
    <DirectoryBrowser {...sharedProps} routePath={requestedRoutePath ?? undefined} routeRequestKey={routeRequestKey} />
  ) : (
    <DirectoryTree {...sharedProps} focusPath={requestedRoutePath ?? undefined} focusRequestKey={routeRequestKey} />
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
  directoryMode,
  onDirectoryModeChange,
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
  directoryMode: DirectoryMode;
  onDirectoryModeChange: (mode: DirectoryMode) => void;
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
  onPreview?: (preview: FilePreviewState) => void;
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
      directoryMode={directoryMode}
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
  const routeSummary = useMemo(() => directoryRouteSummary(root, directoryRoutingRules), [root, directoryRoutingRules]);
  return (
    <section className="space-y-3 pb-4 lg:pb-8">
      <div className="space-y-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,auto)] lg:items-end">
          <div>
            <h3 className="text-lg font-semibold">
              <span className="sr-only lg:not-sr-only">{title}</span>
            </h3>
            {statsLabel && <p className="mt-1 text-xs text-muted-foreground">{statsLabel}</p>}
          </div>
          <p className="text-sm text-muted-foreground lg:text-right">
            <span className="sr-only lg:not-sr-only">{description}</span>
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className="hidden shrink-0 lg:block">
            <DirectoryModeSwitch mode={directoryMode} onChange={onDirectoryModeChange} />
          </div>
          <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded-md border bg-card p-1">
            <div className="app-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {tabs.map((source) =>
                source.kind === "tracked" && trackedPresenceOptions.length > 1 ? (
                  <div
                    key={source.key}
                    ref={trackedMenuRef}
                    className={`relative flex h-7 shrink-0 overflow-hidden rounded ${source.key === activeKey ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    <button
                      className="inline-flex min-w-0 items-center gap-2 px-2.5 text-xs font-medium"
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
                      className={`grid w-7 place-items-center border-l ${source.key === activeKey ? "border-primary-foreground/25 hover:bg-primary-foreground/10" : "border-border hover:bg-muted"}`}
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
                    className={`inline-flex h-7 shrink-0 items-center gap-2 rounded px-2.5 text-xs font-medium ${
                      source.key === activeKey
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
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
            {onCheckSources && !mobileNavigationLayout && (
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
            {mobileNavigationLayout && (
              <>
                <button
                  ref={mobileActionsRef}
                  type="button"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
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
                    {onCheckSources && (
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
                    )}
                    <div className="my-1 border-t" />
                    <div className="px-2 py-1 text-2xs font-semibold uppercase text-muted-foreground">
                      {i18n.t("libraryDetail.view")}
                    </div>
                    {(["browse", "tree"] as DirectoryMode[]).map((mode) => (
                      <button
                        key={mode}
                        role="menuitemradio"
                        aria-checked={directoryMode === mode}
                        className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
                        onClick={() => {
                          onDirectoryModeChange(mode);
                          setMobileActionsOpen(false);
                        }}
                      >
                        {mode === "browse" ? <Folder className="h-4 w-4" /> : <FolderTree className="h-4 w-4" />}
                        <span className="flex-1">
                          {mode === "browse" ? i18n.t("libraryDetail.browse") : i18n.t("libraryDetail.tree")}
                        </span>
                        {directoryMode === mode && <Check className="h-4 w-4 text-primary" />}
                      </button>
                    ))}
                  </div>
                </AnchoredPopover>
              </>
            )}
          </div>
        </div>
        {routeSummary && (
          <DirectoryRouteSummary
            summary={routeSummary}
            onSelect={() => setRequestedRoutePath([...routeSummary.path])}
          />
        )}
      </div>
      <Card>
        <CardContent className="p-4">
          {toolbar}
          {loadingMessage && (
            <div className="mb-4 rounded-md border bg-background p-3 text-sm text-muted-foreground">
              {loadingMessage}
            </div>
          )}
          {selectionPanel}
          {content}
        </CardContent>
      </Card>
      {selectionModal}
    </section>
  );
}

function DirectoryModeSwitch({ mode, onChange }: { mode: DirectoryMode; onChange: (mode: DirectoryMode) => void }) {
  return (
    <div className={segmentedListClassName("gap-0.5 p-0.5")} role="group">
      <button
        className={segmentedItemClassName(mode === "browse", "h-7 gap-1 px-2 text-xs")}
        aria-pressed={mode === "browse"}
        title={i18n.t("libraryDetail.browse")}
        onClick={() => onChange("browse")}
      >
        <Folder className="h-3.5 w-3.5" />
        {i18n.t("libraryDetail.browse")}
      </button>
      <button
        className={segmentedItemClassName(mode === "tree", "h-7 gap-1 px-2 text-xs")}
        aria-pressed={mode === "tree"}
        title={i18n.t("libraryDetail.tree")}
        onClick={() => onChange("tree")}
      >
        <FolderTree className="h-3.5 w-3.5" />
        {i18n.t("libraryDetail.tree")}
      </button>
    </div>
  );
}

function DirectoryRouteSummary({ summary, onSelect }: { summary: DirectoryRouteMatch; onSelect: () => void }) {
  const hasMatch = summary.positiveMatches.length > 0;

  return (
    <>
      <div className="flex min-w-0 items-center rounded-md border bg-card px-3 py-2 text-xs lg:hidden">
        {hasMatch ? (
          <>
            <span className="shrink-0 font-medium text-muted-foreground">{i18n.t("libraryDetail.matched")}</span>
            <button
              type="button"
              className="ml-2 min-w-0 max-w-full truncate rounded-md border bg-secondary px-2 py-0.5 text-left font-medium text-secondary-foreground hover:bg-secondary/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={i18n.t("libraryDetail.openPath", { path: summary.pathLabel })}
              aria-label={i18n.t("libraryDetail.matchedPath", { path: summary.pathLabel })}
              onClick={onSelect}
            >
              {summary.pathLabel}
            </button>
          </>
        ) : (
          <span className="truncate font-medium text-muted-foreground">{i18n.t("libraryDetail.noMatchingFolder")}</span>
        )}
      </div>
      <div className="hidden flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs lg:flex">
        <span className="font-medium text-muted-foreground">{i18n.t("libraryDetail.defaultFolder")}</span>
        <button
          type="button"
          className="max-w-full truncate rounded-md border bg-secondary px-2 py-0.5 font-medium text-secondary-foreground hover:bg-secondary/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={i18n.t("libraryDetail.openPath", { path: summary.pathLabel })}
          onClick={onSelect}
        >
          {summary.pathLabel}
        </button>
        {hasMatch ? (
          <span className="min-w-0 text-muted-foreground">
            {i18n.t("libraryDetail.matchedRules", { rules: summary.positiveMatches.join(" + ") })}
          </span>
        ) : (
          <span className="text-muted-foreground">{i18n.t("libraryDetail.fallbackPlayableMedia")}</span>
        )}
        {summary.negativeMatches.length > 0 && (
          <span className="text-muted-foreground">
            {i18n.t("libraryDetail.excludedRules", { rules: summary.negativeMatches.join(" + ") })}
          </span>
        )}
      </div>
    </>
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
