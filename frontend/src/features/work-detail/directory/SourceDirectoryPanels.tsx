import i18n from "@/i18n";
import { LibraryOfflineNotice } from "@/components/library-offline/LibraryOfflineNotice";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, ChevronsDownUp, ChevronsUpDown, Languages, RefreshCw } from "lucide-react";
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
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TreeNode, TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import type { FilePreviewRequest } from "@/features/work-detail/dialogs/FilePreviewDialog";
import { DirectoryExplorer } from "@/features/work-detail/directory/DirectoryExplorer";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { nodeAtPath, treeHasDisplayNames } from "@/features/work-detail/directory/directoryModel";
import {
  DirectoryNameClampContext,
  DirectoryOriginalNamesContext,
} from "@/features/work-detail/directory/directoryNames";
import { useOriginalFileNames } from "@/lib/originalFileNames";
import { cn } from "@/lib/tailwindClassNames";
import { IconButton } from "@/components/ui/icon-button";
import { buttonVariants } from "@/components/ui/button";
import { createPortal } from "react-dom";
import { useDirectoryTabMenu } from "@/features/work-detail/directory/directoryTabMenu";
import {
  SourceVisibilityPicker,
  sourceVisibilityIcon,
  type SourceVisibilityRow,
} from "@/components/source-visibility/SourceVisibilityPicker";
import { sourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import {
  sourcePickerTabs,
  sourceTabStrip,
  sourceTabVisibilityEntries,
} from "@/features/work-detail/source/sourceTabVisibility";
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
  offline = false,
  remoteSources,
  onSelectRemote,
}: {
  status: SourceTabInfo["status"];
  /** The local files are on an offline storage pool rather than missing. */
  offline?: boolean;
  remoteSources: RemoteSourceAvailability[];
  onSelectRemote: (remote: RemoteSourceAvailability) => void;
}) {
  const availableSources = remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
  const fetchButtons = availableSources.map((remote) => (
    <Button key={remote.source.id} variant="outline" size="sm" onClick={() => onSelectRemote(remote)}>
      {i18n.t("detailActions.fetch")} {remote.source.displayName}
    </Button>
  ));
  if (offline) {
    return (
      <div className="space-y-3">
        <LibraryOfflineNotice />
        {fetchButtons.length > 0 && <div className="flex flex-wrap gap-2">{fetchButtons}</div>}
      </div>
    );
  }
  return (
    <div
      className={`rounded-md border p-4 text-sm ${status === "unavailable" ? "border-error-border bg-error-surface text-error-foreground" : "border-warning-border bg-warning-surface text-warning-foreground"}`}
    >
      <div className="font-medium">{i18n.t("libraryDetail.localFilesUnavailable")}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {fetchButtons.length > 0 ? (
          fetchButtons
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
  description,
  onRefresh,
}: {
  checking: boolean;
  checkedAt: string;
  remoteSources: RemoteSourceAvailability[];
  description?: string;
  /** Asks the remote sources again; absent where none can have the work. */
  onRefresh?: () => void;
}) {
  const availableSources = remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
  return (
    <div className="rounded-md border border-warning-border bg-warning-surface p-4 text-sm text-warning-foreground">
      <div className="font-medium">{i18n.t("libraryDetail.noSourceLinked")}</div>
      <p className="mt-1 text-warning-foreground/80">
        {description ?? i18n.t("libraryDetail.noSourceDirectoryDescription")}
      </p>
      {availableSources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {availableSources.map((remote) => (
            <Badge key={remote.source.id} variant="outline">
              {i18n.t("libraryDetail.sourceAvailable", { source: remote.source.displayName })}
            </Badge>
          ))}
        </div>
      )}
      {onRefresh && (
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
      )}
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

/**
 * Switches the directory between display names and the files' real names. It
 * is pressed while display names show; its hint says which names are shown.
 */
function DisplayNamesToggle({ original, onToggle }: { original: boolean; onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant="toolbar"
      size="icon-sm"
      className={cn(
        "shrink-0",
        !original && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
      )}
      aria-label={i18n.t("libraryDetail.displayNames")}
      aria-pressed={!original}
      title={original ? i18n.t("libraryDetail.displayNamesOffHint") : i18n.t("libraryDetail.displayNamesOnHint")}
      onClick={onToggle}
    >
      <Languages className="h-3.5 w-3.5" />
    </Button>
  );
}

/**
 * Lets long file and folder names wrap in full instead of stopping at two
 * lines. It is pressed while names show in full.
 */
function FullNamesToggle({ full, onToggle }: { full: boolean; onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant="toolbar"
      size="icon-sm"
      className={cn(
        "shrink-0",
        full && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
      )}
      aria-label={i18n.t("libraryDetail.fullNames")}
      aria-pressed={full}
      title={full ? i18n.t("libraryDetail.fullNamesOnHint") : i18n.t("libraryDetail.fullNamesOffHint")}
      onClick={onToggle}
    >
      {full ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
    </Button>
  );
}

const fullNamesStorageKey = "kikoto:work-directory-full-names";

/** Whether this device shows long directory names in full; the choice stays on this device. */
function useFullDirectoryNames() {
  const [full, setFull] = useState(() => {
    try {
      return localStorage.getItem(fullNamesStorageKey) === "true";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setFull((current) => {
      try {
        localStorage.setItem(fullNamesStorageKey, String(!current));
      } catch {
        // The choice still applies to this page view.
      }
      return !current;
    });
  return [full, toggle] as const;
}

function directoryRouteRequestKey(routeStateKey: string | undefined, activeKey: string, trackedPresenceKey: string) {
  return [routeStateKey ?? "", activeKey, trackedPresenceKey].join("\u0000");
}

export function SourceDirectoryPanel({
  title,
  description,
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
  const [requestedRoutePath, setRequestedRoutePath] = useState<string[] | null>(null);
  const [requestedRouteStateKey, setRequestedRouteStateKey] = useState(() =>
    directoryRouteRequestKey(routeStateKey, activeKey, selectedTrackedPresenceKey),
  );
  const descriptionId = useId();
  const mobileNavigationLayout = useMobileNavigationLayout();
  const sourceTabVisibility = useSourceTabVisibility();
  const [fullNames, toggleFullNames] = useFullDirectoryNames();
  const tabMenu = useDirectoryTabMenu();
  const routeRequestKey = directoryRouteRequestKey(routeStateKey, activeKey, selectedTrackedPresenceKey);
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
  const hasDisplayNames = useMemo(() => !emptyState && treeHasDisplayNames(root), [emptyState, root]);
  const [originalNamesPreferred, toggleOriginalNames] = useOriginalFileNames();
  const originalNames = hasDisplayNames && originalNamesPreferred;
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
  // A phone stops long names at two lines unless asked for them in full.
  const clampableNames = mobileNavigationLayout && !emptyState;
  const visibilityTitle = i18n.t("libraryDetail.sourceTabVisibility");
  const checkSourcesLabel = checkingSources
    ? i18n.t("libraryDetail.checkingSources")
    : checkedAt
      ? i18n.t("libraryDetail.checkSourcesLastChecked", { time: formatDateTime(checkedAt) })
      : i18n.t("libraryDetail.checkSources");
  // A compact detail has no header row. Its source menu lists every source,
  // since the menu keeps them out of the way already, then Check sources; the
  // name toggles sit at the end of its Info and Directory row.
  const tabMenuTools =
    tabMenu?.tools &&
    (hasDisplayNames || clampableNames) &&
    createPortal(
      <>
        {hasDisplayNames && <DisplayNamesToggle original={originalNamesPreferred} onToggle={toggleOriginalNames} />}
        {clampableNames && <FullNamesToggle full={fullNames} onToggle={toggleFullNames} />}
      </>,
      tabMenu.tools,
    );
  const tabMenuControls =
    tabMenu?.host &&
    createPortal(
      <>
        <SourcePickerList
          sources={sourcePickerTabs(tabs, activeKey)}
          activeKey={activeKey}
          onActiveKeyChange={onActiveKeyChange}
          trackedPresenceOptions={trackedPresenceOptions}
          selectedTrackedPresenceKey={selectedTrackedPresenceKey}
          onTrackedPresenceChange={onTrackedPresenceChange}
          onPicked={tabMenu.close}
        />
        {onCheckSources && (
          <div className="mt-1 border-t pt-1">
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-60"
              disabled={checkingSources}
              onClick={() => {
                tabMenu.close();
                onCheckSources();
              }}
            >
              <RefreshCw className={cn("h-4 w-4 shrink-0", checkingSources && "animate-spin")} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {checkingSources ? i18n.t("libraryDetail.checkingSources") : i18n.t("libraryDetail.checkSources")}
                </span>
                {!checkingSources && checkedAt && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {i18n.t("libraryDetail.checkedAt", { time: formatDateTime(checkedAt) })}
                  </span>
                )}
              </span>
            </button>
          </div>
        )}
      </>,
      tabMenu.host,
    );
  const headerSourceControls = !tabMenu && (
    <>
      <SourceVisibilityPicker
        title={visibilityTitle}
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
      {onCheckSources && (
        <IconButton title={checkSourcesLabel} onClick={onCheckSources} disabled={checkingSources}>
          <RefreshCw className={`h-3.5 w-3.5 ${checkingSources ? "animate-spin" : ""}`} />
        </IconButton>
      )}
    </>
  );
  // A lone source has nothing to switch to: name it instead of a one-tab
  // strip, and leave an unusable one to the empty state below.
  const singleSource =
    !showSourceTabs && visibleTabs.length === 1 && visibleTabs[0].status === "available" ? visibleTabs[0] : null;
  const singleSourceName =
    singleSource?.sourceName && singleSource.sourceName !== singleSource.label
      ? `${singleSource.label} · ${singleSource.sourceName}`
      : singleSource?.label;
  const sourceTabs = (
    <SourceTabStrip
      visibleTabs={visibleTabs}
      activeKey={activeKey}
      onActiveKeyChange={onActiveKeyChange}
      trackedPresenceOptions={trackedPresenceOptions}
      selectedTrackedPresenceKey={selectedTrackedPresenceKey}
      onTrackedPresenceChange={onTrackedPresenceChange}
    />
  );
  const headerControls = !tabMenu && (hasDisplayNames || clampableNames || headerSourceControls) && (
    <div className="flex shrink-0 items-center gap-1">
      {hasDisplayNames && <DisplayNamesToggle original={originalNamesPreferred} onToggle={toggleOriginalNames} />}
      {clampableNames && <FullNamesToggle full={fullNames} onToggle={toggleFullNames} />}
      {headerSourceControls}
    </div>
  );
  return (
    <section className="pb-4 lg:pb-8" data-testid="directory-panel" aria-label={title} aria-describedby={descriptionId}>
      {/* The panel opens on its sources: the source tabs, or the one source by
          name, with the name and source controls at the row's end; a compact
          detail moves all of them into its source sheet. What the files are is
          stated only to assistive technology. */}
      <p id={descriptionId} className="sr-only">
        {description}
      </p>
      {/* Clip rather than hide overflow so the folder navigator can stay sticky. */}
      <div className="overflow-clip rounded-xl border bg-card">
        {!tabMenu && (showSourceTabs || singleSource || headerControls) && (
          <div className="flex min-w-0 items-center gap-2 border-b pr-2 sm:pr-3">
            {showSourceTabs ? (
              <div className="app-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden px-2">
                {sourceTabs}
              </div>
            ) : singleSource ? (
              <div
                className="flex h-10 min-w-0 flex-1 items-center gap-2 px-4 text-sm font-medium"
                title={`${singleSource.label}: ${singleSource.statusLabel}`}
                data-testid="directory-single-source"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(singleSource.status)}`}
                  aria-hidden="true"
                />
                <span className="truncate">{singleSourceName}</span>
              </div>
            ) : (
              <div className="h-10 flex-1" />
            )}
            {headerControls}
          </div>
        )}
        {tabMenuControls}
        {tabMenuTools}

        <div className="p-2 sm:p-3">
          {toolbar}
          {loadingMessage && (
            <div className="mb-3 rounded-md border bg-background p-3 text-sm text-muted-foreground">
              {loadingMessage}
            </div>
          )}
          {selectionPanel}
          <DirectoryOriginalNamesContext.Provider value={originalNames}>
            <DirectoryNameClampContext.Provider value={clampableNames && !fullNames}>
              {content}
            </DirectoryNameClampContext.Provider>
          </DirectoryOriginalNamesContext.Provider>
        </div>
      </div>
      {selectionModal}
    </section>
  );
}

function SourceTabStrip({
  visibleTabs,
  activeKey,
  onActiveKeyChange,
  trackedPresenceOptions,
  selectedTrackedPresenceKey,
  onTrackedPresenceChange,
}: {
  visibleTabs: SourceTabInfo[];
  activeKey: string;
  onActiveKeyChange: (key: string) => void;
  trackedPresenceOptions: TrackedPresenceOption[];
  selectedTrackedPresenceKey: string;
  onTrackedPresenceChange?: (key: string) => void;
}) {
  const [trackedMenuOpen, setTrackedMenuOpen] = useState(false);
  const trackedMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setTrackedMenuOpen(false);
  }, [activeKey, selectedTrackedPresenceKey]);
  const tabClassName = (active: boolean) =>
    `relative inline-flex h-10 shrink-0 items-center gap-2 px-3 text-sm font-medium transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full ${
      active ? "text-foreground after:bg-primary" : "text-muted-foreground after:bg-transparent hover:text-foreground"
    }`;
  return (
    <>
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
    </>
  );
}

/**
 * The sources of a compact detail's source menu, one choice each by name;
 * several tracked forks are listed under Tracked. Picking one closes the menu.
 */
function SourcePickerList({
  sources,
  activeKey,
  onActiveKeyChange,
  trackedPresenceOptions,
  selectedTrackedPresenceKey,
  onTrackedPresenceChange,
  onPicked,
}: {
  sources: SourceTabInfo[];
  activeKey: string;
  onActiveKeyChange: (key: string) => void;
  trackedPresenceOptions: TrackedPresenceOption[];
  selectedTrackedPresenceKey: string;
  onTrackedPresenceChange?: (key: string) => void;
  onPicked: () => void;
}) {
  const title = i18n.t("libraryDetail.directorySource");
  return (
    <div role="radiogroup" aria-label={title}>
      {sources.map((source) =>
        source.kind === "tracked" && trackedPresenceOptions.length > 1 ? (
          <div key={source.key} role="group" aria-label={i18n.t("libraryDetail.trackedSources")}>
            <div className="px-3 pb-1 pt-2 text-xs font-semibold text-muted-foreground">{source.label}</div>
            {trackedPresenceOptions.map((option) => (
              <SourcePickerOption
                key={option.key}
                label={option.label}
                status={option.status}
                statusLabel={option.statusLabel}
                checked={source.key === activeKey && option.key === selectedTrackedPresenceKey}
                onSelect={() => {
                  onTrackedPresenceChange?.(option.key);
                  onPicked();
                }}
              />
            ))}
          </div>
        ) : (
          <SourcePickerOption
            key={source.key}
            label={source.label}
            status={source.status}
            statusLabel={source.statusLabel}
            checked={source.key === activeKey}
            onSelect={() => {
              onActiveKeyChange(source.key);
              onPicked();
            }}
          />
        ),
      )}
    </div>
  );
}

function SourcePickerOption({
  label,
  status,
  statusLabel,
  checked,
  onSelect,
}: {
  label: string;
  status: SourceTabInfo["status"];
  statusLabel: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={cn(
        "flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 text-left hover:bg-muted focus:bg-muted focus:outline-none",
        checked && "font-medium text-primary",
      )}
      title={`${label}: ${statusLabel}`}
      onClick={onSelect}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(status)}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="sr-only">{statusLabel}</span>
      {checked && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
    </button>
  );
}

export function DirectoryMessage({ message }: { message: string }) {
  return <div className="mb-4 rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">{message}</div>;
}

/**
 * Tells a library manager that a work's files lie in several local folders or
 * editions, and opens the tools that bring them into one.
 */
export function LocalCopiesBanner({
  folderCount,
  offlineFolderCount = 0,
  editionCount,
  onManageFiles,
  onManageLyrics,
}: {
  folderCount: number;
  /** Folders whose storage pool is offline; their files are not listed. */
  offlineFolderCount?: number;
  editionCount: number;
  onManageFiles: () => void;
  onManageLyrics?: () => void;
}) {
  const severalFolders = folderCount > 1;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
      <div className="min-w-0 flex-1 basis-64">
        <div className="font-medium">
          {severalFolders
            ? i18n.t("libraryDetail.localCopiesFolders", { count: folderCount })
            : i18n.t("libraryDetail.localCopiesEditions", { count: editionCount })}
        </div>
        <div className="text-xs text-muted-foreground">{i18n.t("libraryDetail.localCopiesHint")}</div>
        {offlineFolderCount > 0 && (
          <div className="mt-0.5 text-xs text-warning-foreground">{i18n.t("libraryOffline.someFolders")}</div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {onManageLyrics && (
          <Button size="sm" variant="outline" onClick={onManageLyrics}>
            {i18n.t("detailActions.manageLyrics")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onManageFiles}>
          {i18n.t("libraryDetail.manageFiles")}
        </Button>
      </div>
    </div>
  );
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
