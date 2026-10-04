import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AudioLines, Captions, Folder, Play, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { FilePreviewRequest } from "@/features/work-detail/dialogs/FilePreviewDialog";
import { DirectoryBreadcrumb } from "@/features/work-detail/directory/DirectoryBreadcrumb";
import {
  DirectoryFileRow,
  type DirectoryFileHandlers,
  DirectoryImageTile,
  type DirectoryPlayFolder,
} from "@/features/work-detail/directory/DirectoryFileRows";
import {
  activeTrackFolderPath,
  cursorInTree,
  type DirectoryRouteMatch,
  directoryRouteSummary,
  folderAncestorKeys,
  folderNavigatorRows,
  folderSections,
  folderSummary,
  initialFolderNavigatorExpansion,
  isActiveTreeTrack,
  nodeAtPath,
  pathWithin,
  previewsForFiles,
  recommendedDirectoryPath,
  samePath,
  sortedFiles,
  sortedFolders,
  treeHasFolders,
} from "@/features/work-detail/directory/directoryModel";
import {
  FolderPickerButton,
  FolderRail,
  type FolderNavigatorProps,
} from "@/features/work-detail/directory/FolderNavigator";
import { useLivePlaybackCursor } from "@/features/work-detail/directory/useLivePlaybackCursor";
import {
  directoryLyricsAttachments,
  formatDuration,
  playableFiles,
  type TreeNode,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import i18n from "@/i18n";
import type { DirectoryRoutingRule } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

const trackPageSize = 160;
const imagePageSize = 24;
// Below this width the folder column would squeeze file names; the navigator moves behind a button.
const folderRailMinWidthRem = 38;

/** Whether an element is at least `minWidthRem` wide, measured before paint and on resize. */
function useWidthAtLeast(element: HTMLElement | null, minWidthRem: number) {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (!element) return;
    const update = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setWide(element.getBoundingClientRect().width >= minWidthRem * rem);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, minWidthRem]);
  return wide;
}

function useDirectoryLyricsAttachmentVisibility(root: TreeNode) {
  const attachments = useMemo(() => directoryLyricsAttachments(root), [root]);
  const [showingAll, setShowingAll] = useState(false);
  const [revealedLocationIDs, setRevealedLocationIDs] = useState<Set<number>>(new Set());
  useEffect(() => {
    setShowingAll(false);
    setRevealedLocationIDs(new Set());
  }, [root]);
  const contains = useCallback((locationID: number) => attachments.hiddenLocationIds.has(locationID), [attachments]);
  const isHidden = useCallback(
    (locationID: number) => contains(locationID) && !showingAll && !revealedLocationIDs.has(locationID),
    [contains, revealedLocationIDs, showingAll],
  );
  const reveal = useCallback(
    (locationID: number) => {
      if (!attachments.hiddenLocationIds.has(locationID)) return;
      setRevealedLocationIDs((current) => new Set(current).add(locationID));
    },
    [attachments],
  );
  const toggleAll = useCallback(() => {
    if (showingAll) setRevealedLocationIDs(new Set());
    setShowingAll(!showingAll);
  }, [showingAll]);
  return { contains, isHidden, reveal, showingAll, toggleAll };
}

function LyricsAttachmentsToggle({
  count,
  showingAll,
  onToggle,
}: {
  count: number;
  showingAll: boolean;
  onToggle: () => void;
}) {
  if (count === 0) return null;
  const label = showingAll
    ? i18n.t("libraryDetail.hideAttachedLyrics")
    : i18n.t("libraryDetail.showAttachedLyrics", { count });
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`h-8 gap-1.5 px-2 text-xs ${showingAll ? "text-primary" : "text-muted-foreground"}`}
      onClick={onToggle}
      aria-pressed={showingAll}
      aria-label={label}
      title={label}
    >
      <Captions className="h-4 w-4" />
      <span className="tabular-nums">{count}</span>
    </Button>
  );
}

type DirectoryRouteBaseline = { root: TreeNode; directoryRoutingRules: DirectoryRoutingRule[] };

function directoryRouteBaselineChanged(
  baselineRef: RefObject<DirectoryRouteBaseline | null>,
  root: TreeNode,
  directoryRoutingRules: DirectoryRoutingRule[],
) {
  const baseline = baselineRef.current;
  baselineRef.current = { root, directoryRoutingRules };
  return !baseline || baseline.root !== root || baseline.directoryRoutingRules !== directoryRoutingRules;
}

function recommendationReason(summary: DirectoryRouteMatch) {
  const reasons = [
    summary.positiveMatches.length > 0
      ? i18n.t("libraryDetail.matchedRules", { rules: summary.positiveMatches.join(" + ") })
      : i18n.t("libraryDetail.fallbackPlayableMedia"),
  ];
  if (summary.negativeMatches.length > 0) {
    reasons.push(i18n.t("libraryDetail.excludedRules", { rules: summary.negativeMatches.join(" + ") }));
  }
  return i18n.t("libraryDetail.recommendedReason", { reason: reasons.join(" · ") });
}

function RecommendedFolderIndicator({
  summary,
  reason,
  current,
  onOpen,
}: {
  summary: DirectoryRouteMatch | null;
  reason: string;
  current: boolean;
  onOpen: () => void;
}) {
  if (!summary) return null;
  if (current) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary"
        title={reason}
      >
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        <span>{i18n.t("libraryDetail.recommended")}</span>
        <span className="sr-only">{reason}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={i18n.t("libraryDetail.openPath", { path: summary.pathLabel })}
      onClick={onOpen}
    >
      <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{i18n.t("libraryDetail.openRecommendedFolder")}</span>
    </button>
  );
}

function PlayAllButton({ tracks, onPlayFolder }: { tracks: TreeTrack[]; onPlayFolder: DirectoryPlayFolder }) {
  if (tracks.length === 0) return null;
  return (
    <Button size="sm" className="h-8 gap-1.5 px-3 text-xs" onClick={() => onPlayFolder(tracks, tracks[0].locationId)}>
      <Play className="h-3.5 w-3.5 fill-current" />
      {i18n.t("libraryDetail.playAll")}
      <span className="tabular-nums opacity-80">{tracks.length}</span>
    </Button>
  );
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <h4 className="flex items-baseline gap-1.5 px-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
      {label}
      <span className="font-normal tabular-nums">{count}</span>
    </h4>
  );
}

function FolderTile({
  folder,
  recommended,
  playing,
  onOpen,
  onPlayFolder,
}: {
  folder: TreeNode;
  recommended: boolean;
  playing: boolean;
  onOpen: () => void;
  onPlayFolder?: DirectoryPlayFolder;
}) {
  const tracks = useMemo(() => playableFiles(sortedFiles(folder)), [folder]);
  return (
    <div className="flex min-h-14 items-stretch rounded-lg border bg-background/60 transition-colors hover:bg-muted/70">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
      >
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-md",
            playing ? "bg-primary/15 text-primary" : "bg-primary/10 text-primary",
          )}
        >
          {playing ? <AudioLines className="h-4 w-4 motion-safe:animate-pulse" /> : <Folder className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block whitespace-normal break-words font-medium [overflow-wrap:anywhere]">
            {folder.name}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{folderSummary(folder)}</span>
        </span>
        {recommended && <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />}
      </button>
      {onPlayFolder && tracks.length > 0 && (
        <button
          type="button"
          className="grid w-11 shrink-0 place-items-center rounded-r-lg border-l text-muted-foreground hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={i18n.t("libraryDetail.playFolder", { name: folder.name })}
          title={i18n.t("libraryDetail.playFolder", { name: folder.name })}
          onClick={() => onPlayFolder(tracks, tracks[0].locationId)}
        >
          <Play className="h-4 w-4 fill-current" />
        </button>
      )}
    </div>
  );
}

function ShowMoreButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="mt-1 w-full" onClick={onClick}>
      {label}
    </Button>
  );
}

/**
 * Work files as a folder explorer: a folder navigator beside the selected
 * folder's contents on wide directories, and the same navigator behind a
 * button on compact ones. Contents group subfolders, playable tracks, an image
 * gallery, documents, and other files.
 */
export function DirectoryExplorer({
  root,
  directoryRoutingRules,
  routePath,
  routeRequestKey,
  currentLocationId,
  currentPlaybackKey,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  emptyLabel = i18n.t("libraryDetail.localFilesUnavailable"),
}: {
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  routePath?: string[];
  routeRequestKey?: string;
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  onPlayFolder?: DirectoryPlayFolder;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (request: FilePreviewRequest) => void;
  emptyLabel?: string;
}) {
  const routeSummary = useMemo(() => directoryRouteSummary(root, directoryRoutingRules), [root, directoryRoutingRules]);
  const recommendedPath = routeSummary?.path ?? null;
  const [path, setPath] = useState<string[]>(() => recommendedDirectoryPath(root, directoryRoutingRules));
  const appliedRouteRequestKeyRef = useRef<string | null>(null);
  const pathBaselineRef = useRef<DirectoryRouteBaseline | null>(null);
  const lyricsAttachments = useDirectoryLyricsAttachmentVisibility(root);
  const liveCursor = useLivePlaybackCursor();
  const treeCursor = useMemo(() => cursorInTree(root, liveCursor), [liveCursor, root]);
  const playingPath = useMemo(
    () => activeTrackFolderPath(root, currentLocationId, currentPlaybackKey),
    [currentLocationId, currentPlaybackKey, root],
  );
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() =>
    initialFolderNavigatorExpansion(root, [path, recommendedPath, playingPath]),
  );
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const wide = useWidthAtLeast(container, folderRailMinWidthRem);
  const [trackLimit, setTrackLimit] = useState(trackPageSize);
  const [imageLimit, setImageLimit] = useState(imagePageSize);

  useEffect(() => {
    if (!nodeAtPath(root, path)) {
      setPath(recommendedDirectoryPath(root, directoryRoutingRules));
    }
  }, [root, path, directoryRoutingRules]);

  useEffect(() => {
    // Routing rules can arrive after the route request; a reset must keep it.
    const baselineChanged = directoryRouteBaselineChanged(pathBaselineRef, root, directoryRoutingRules);
    const requestedPath = routePath && nodeAtPath(root, routePath) ? routePath : null;
    const requestKey = requestedPath ? (routeRequestKey ?? requestedPath.join("\u0000")) : null;
    const requestPending = requestKey !== null && appliedRouteRequestKeyRef.current !== requestKey;
    if (!baselineChanged && !requestPending) return;
    if (requestKey) appliedRouteRequestKeyRef.current = requestKey;
    setPath(requestedPath ?? recommendedDirectoryPath(root, directoryRoutingRules));
  }, [directoryRoutingRules, root, routePath, routeRequestKey]);

  const expansionRootRef = useRef(root);
  useEffect(() => {
    if (expansionRootRef.current === root) return;
    expansionRootRef.current = root;
    setExpandedKeys(initialFolderNavigatorExpansion(root, [recommendedPath, playingPath]));
  }, [playingPath, recommendedPath, root]);

  // The selected folder and the folders above it stay open in the navigator.
  useEffect(() => {
    const keys = folderAncestorKeys(root, path);
    setExpandedKeys((current) => (keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys])));
    setTrackLimit(trackPageSize);
    setImageLimit(imagePageSize);
  }, [path, root]);

  const current = useMemo(() => nodeAtPath(root, path) ?? root, [root, path]);
  const folders = useMemo(() => sortedFolders(current), [current]);
  const allFiles = useMemo(() => sortedFiles(current), [current]);
  const playbackTracks = useMemo(() => playableFiles(allFiles), [allFiles]);
  const sections = folderSections(allFiles.filter((file) => !lyricsAttachments.isHidden(file.locationId)));
  const currentLyricsAttachmentCount = allFiles.filter((file) => lyricsAttachments.contains(file.locationId)).length;
  const navigatorRows = useMemo(() => folderNavigatorRows(root, expandedKeys), [root, expandedKeys]);
  const hasFolders = treeHasFolders(root);
  const showRail = hasFolders && wide;
  const recommendedReason = routeSummary ? recommendationReason(routeSummary) : "";

  if (!hasFolders && root.files.length === 0) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }

  const handlers: DirectoryFileHandlers = {
    onPlayFolder,
    onPlayNext,
    onAppendQueue,
    onPreview,
    isLyricsAttachmentHidden: lyricsAttachments.isHidden,
    onRevealLyricsAttachment: lyricsAttachments.reveal,
  };
  const navigatorProps: FolderNavigatorProps = {
    rows: navigatorRows,
    currentPath: path,
    recommendedPath,
    recommendedReason,
    playingPath,
    onSelect: setPath,
    onToggle: (key) =>
      setExpandedKeys((currentKeys) => {
        const next = new Set(currentKeys);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
  };
  const trackDuration = playbackTracks.reduce((total, file) => total + (file.durationSeconds ?? 0), 0);
  const summary =
    playbackTracks.length > 0
      ? [
          i18n.t("libraryDetail.trackCount", { count: playbackTracks.length }),
          trackDuration > 0 ? formatDuration(trackDuration) : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : folderSummary(current);
  const isActive = (file: TreeTrack) => isActiveTreeTrack(file, currentLocationId, currentPlaybackKey);
  const videoPreviews = previewsForFiles(sections.tracks.filter((file) => file.kind === "video"));
  const imagePreviews = previewsForFiles(sections.images);
  const remainingTracks = sections.tracks.length - trackLimit;
  const remainingImages = sections.images.length - imageLimit;

  const blocks: { key: string; label: string; count: number; content: ReactNode }[] = [];
  if (folders.length > 0) {
    blocks.push({
      key: "folders",
      label: i18n.t("libraryDetail.folders"),
      count: folders.length,
      content: (
        <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
          {folders.map((folder) => {
            const folderPath = [...path, folder.name];
            return (
              <FolderTile
                key={folder.path || folder.name}
                folder={folder}
                recommended={pathWithin(recommendedPath, folderPath)}
                playing={pathWithin(playingPath, folderPath)}
                onOpen={() => setPath(folderPath)}
                onPlayFolder={onPlayFolder}
              />
            );
          })}
        </div>
      ),
    });
  }
  if (sections.tracks.length > 0) {
    blocks.push({
      key: "tracks",
      label: i18n.t("libraryDetail.tracks"),
      count: sections.tracks.length,
      content: (
        <div className="space-y-0.5">
          {sections.tracks.slice(0, trackLimit).map((file) => (
            <DirectoryFileRow
              key={file.playbackKey ?? file.locationId}
              file={file}
              tracks={playbackTracks}
              variant="track"
              isActive={isActive(file)}
              liveCursor={treeCursor}
              previewSiblings={videoPreviews}
              handlers={handlers}
            />
          ))}
          {remainingTracks > 0 && (
            <ShowMoreButton
              label={i18n.t("libraryDetail.showMoreFiles", { count: remainingTracks })}
              onClick={() => setTrackLimit((value) => value + trackPageSize)}
            />
          )}
        </div>
      ),
    });
  }
  if (sections.images.length > 0) {
    blocks.push({
      key: "images",
      label: i18n.t("libraryDetail.images"),
      count: sections.images.length,
      content: (
        <div>
          <div className="grid gap-1 [grid-template-columns:repeat(auto-fill,minmax(6.5rem,1fr))]">
            {sections.images.slice(0, imageLimit).map((file) => (
              <DirectoryImageTile
                key={file.playbackKey ?? file.locationId}
                file={file}
                previewSiblings={imagePreviews}
                onPreview={onPreview}
              />
            ))}
          </div>
          {remainingImages > 0 && (
            <ShowMoreButton
              label={i18n.t("libraryDetail.showAllImages", { count: sections.images.length })}
              onClick={() => setImageLimit(sections.images.length)}
            />
          )}
        </div>
      ),
    });
  }
  for (const [key, label, files] of [
    ["documents", i18n.t("libraryDetail.documents"), sections.documents],
    ["others", i18n.t("libraryDetail.otherFiles"), sections.others],
  ] as const) {
    if (files.length === 0) continue;
    const previewSiblings = previewsForFiles(files);
    blocks.push({
      key,
      label,
      count: files.length,
      content: (
        <div className="space-y-0.5">
          {files.map((file) => (
            <DirectoryFileRow
              key={file.playbackKey ?? file.locationId}
              file={file}
              tracks={playbackTracks}
              variant="file"
              isActive={isActive(file)}
              previewSiblings={previewSiblings}
              handlers={handlers}
            />
          ))}
        </div>
      ),
    });
  }
  const labelled = blocks.length > 1;
  const showToolbar = Boolean(summary) || currentLyricsAttachmentCount > 0 || playbackTracks.length > 0;

  return (
    <div ref={setContainer}>
      <div className={cn(showRail && "grid grid-cols-[minmax(10rem,13rem)_minmax(0,1fr)] gap-4")}>
        {showRail && <FolderRail {...navigatorProps} />}
        <div className="min-w-0 space-y-3">
          <div className="space-y-2">
            {hasFolders && (
              <div className="flex min-w-0 items-center gap-1.5">
                {!showRail && <FolderPickerButton {...navigatorProps} />}
                <DirectoryBreadcrumb path={path} onChange={setPath} />
              </div>
            )}
            {showToolbar && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-1">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {summary && <span className="tabular-nums">{summary}</span>}
                  <RecommendedFolderIndicator
                    summary={routeSummary}
                    reason={recommendedReason}
                    current={samePath(path, recommendedPath)}
                    onOpen={() => {
                      if (recommendedPath) setPath([...recommendedPath]);
                    }}
                  />
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <LyricsAttachmentsToggle
                    count={currentLyricsAttachmentCount}
                    showingAll={lyricsAttachments.showingAll}
                    onToggle={lyricsAttachments.toggleAll}
                  />
                  {onPlayFolder && <PlayAllButton tracks={playbackTracks} onPlayFolder={onPlayFolder} />}
                </div>
              </div>
            )}
          </div>
          {blocks.length === 0 ? (
            <div className="px-2 py-6 text-sm text-muted-foreground">{emptyLabel}</div>
          ) : (
            blocks.map((block) => (
              <div key={block.key} className="space-y-1.5">
                {labelled && <SectionHeading label={block.label} count={block.count} />}
                {block.content}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
